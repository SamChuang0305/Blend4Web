"use strict";

/**
 * NLA scheduler module.
 * @name nla
 * @namespace
 * @exports exports as nla
 */
b4w.module["__nla"] = function(exports, require) {

var m_anim      = require("__animation");
var m_cam       = require("__camera");
var m_ctl       = require("__controls");
var m_cfg       = require("__config");
var m_loader    = require("__loader");
var m_particles = require("__particles");
var m_print     = require("__print");
var m_scs       = require("__scenes");
var m_sfx       = require("__sfx");
var m_util      = require("__util");

var cfg_ani = m_cfg.animation;

var _nla_arr = [];
var _start_time = -1;

exports.update_scene_nla = function(scene, is_cyclic) {
    var nla = {
        frame_start: scene["frame_start"],
        frame_end: scene["frame_end"],
        frame_offset: 0,
        last_frame: -1,
        cyclic: is_cyclic,
        objects: [],
        script: [],
        curr_script_slot: 0
    }
    
    prepare_nla_script(scene, nla);

    var sobjs = m_scs.get_scene_objs(scene, "ALL", m_scs.DATA_ID_ALL);

    for (var i = 0; i < sobjs.length; i++) {
        var sobj = sobjs[i];

        var adata = sobj["animation_data"];
        if (adata && adata["nla_tracks"].length) {
            var nla_tracks = adata["nla_tracks"];

            if (m_util.is_armature(sobj) || m_cam.is_camera(sobj) || m_util.is_mesh(sobj)) {
                var nla_events = get_nla_events(nla_tracks);
                sobj._nla_events = nla_events;
            }

            if (m_sfx.is_speaker(sobj)) {
                var nla_events = get_nla_events(nla_tracks);
                sobj._nla_events = nla_events;
            }
        }

        if (m_anim.has_animated_nodemats(sobj)) {
            var materials = sobj["data"]["materials"];

            for (var j = 0; j < materials.length; j++) {
                var mat = materials[j];
                var node_tree = mat["node_tree"];
                var adata = node_tree["animation_data"];
                if (node_tree && adata) {
                    var nla_tracks = adata["nla_tracks"];
                    var nla_events = get_nla_events(nla_tracks);
                    if (sobj._nla_events)
                        sobj._nla_events = sobj._nla_events.concat(nla_events);
                    else
                        sobj._nla_events = nla_events;
                }
            }
        }

        if (sobj._nla_events)
            nla.objects.push(sobj);
    }

    for (var i = 0; i < sobjs.length; i++) {
        var sobj = sobjs[i];

        if (m_particles.has_particles(sobj) &&
                m_particles.has_anim_particles(sobj)) {

            var ev = {
                frame_start: nla.frame_start,
                frame_end: nla.frame_end+1,
                scheduled: false,
                paused: false,
                action: null,
                action_frame_start: 0,
                action_frame_end: 0,
                ext_frame_start: 0,
                ext_frame_end: 0
            }
            sobj._nla_events = [ev];
            nla.objects.push(sobj);
        }
    }

    enforce_nla_consistency(nla);
    calc_nla_extents(nla);

    _nla_arr.push(nla);
}

function prepare_nla_script(scene, nla) {
    var bpy_nla_script = scene["b4w_nla_script"];
    var nla_script = nla.script;

    for (var i = 0; i < bpy_nla_script.length; i++) {
        var sslot = bpy_nla_script[i];

        switch (sslot["type"]) {
        case "PLAY":
            nla_script.push({
                type: "PLAY",
                frame_start: sslot["frame_range"][0],
                frame_end: sslot["frame_range"][1],
                in_play: false
            });
            break;
        case "JUMP":
            nla_script.push({
                type: "JUMP",
                slot_idx: sslot["target_slot"]
            });
            break;
        case "SELECT":
        case "SELECT_PLAY":
            var obj = m_scs.get_object(m_scs.GET_OBJECT_BY_NAME, sslot["object"], 0);

            var sel_objs = m_scs.get_selectable_objects(scene);
            var obj_idx = sel_objs.indexOf(obj);

            if (obj_idx == -1) {
                m_print.error("NLA script error: non-selectable object");
                return [];
            }

            var slot = {
                type: sslot["type"],
                slot_idx_hit: sslot["type"] == "SELECT" ? sslot["target_slot"] : i+1,
                slot_idx_miss: i+1,
                sel_state: -1,
                sel_objs_len: sel_objs.length,
                sel_obj_idx: obj_idx,

                frame_start: sslot["frame_range"][0],
                frame_end: sslot["frame_range"][1],
                in_play: false
            }

            var sel_sensors = [];
            for (var j = 0; j < sel_objs.length; j++) {
                sel_sensors.push(m_ctl.create_selection_sensor(sel_objs[j], true));
            }

            var select_cb = function(obj, id, pulse, param) {
                if (nla.curr_script_slot >= nla.script.length)
                    return;

                var slot = nla.script[nla.curr_script_slot];

                if (!(slot.type == "SELECT" || (slot.type == "SELECT_PLAY" && !slot.in_play)))
                    return;

                for (var i = 0; i < param.sel_objs_len; i++) {
                    if (m_ctl.get_sensor_value(obj, id, i) &&
                            i == param.sel_obj_idx) {
                        param.sel_state = 1;
                        return;
                    }
                }
                param.sel_state = 0;
            }

            m_ctl.create_sensor_manifold(obj, "NLA_SELECT_" + i, m_ctl.CT_SHOT,
                    sel_sensors, m_ctl.default_OR_logic_fun, select_cb, slot);

            nla_script.push(slot);

            break;
        case "NOOP":
            nla_script.push({
                type: "NOOP"
            });
            break;
        }
    }
}

function enforce_nla_consistency(nla) {

    var start = nla.frame_start;
    var end = nla.frame_end;

    for (var i = 0; i < nla.objects.length; i++) {
        var obj = nla.objects[i];

        var nla_events = obj._nla_events;

        for (var j = 0; j < nla_events.length; j++) {
            var ev = nla_events[j];

            // for possible warnings
            var strip_str = obj["name"] + " [" + ev.frame_start + ":" +
                    ev.frame_end + "]";

            ev.frame_start = Math.max(start, ev.frame_start);
            // see typical cyclic NLA usecases to undestand why +1
            ev.frame_end = Math.min(end+1, ev.frame_end);

            // out of scene range
            if (ev.frame_start > ev.frame_end) {
                m_print.warn("NLA: out of scene range: " + strip_str);
                nla_events.splice(j, 1);
                j--;
            }
        }
    }
}

function calc_nla_extents(nla) {

    for (var i = 0; i < nla.objects.length; i++) {
        var obj = nla.objects[i];

        var nla_events = obj._nla_events;

        for (var j = 0; j < nla_events.length; j++) {
            var ev = nla_events[j];

            var ext_frame_start = nla.frame_start;
            var ext_frame_end = nla.frame_end+1;

            for (var k = 0; k < nla_events.length; k++) {
                var ev_k = nla_events[k];

                if (ev_k.frame_end <= ev.frame_start)
                    ext_frame_start = ev.frame_start;

                if (ev_k.frame_start >= ev.frame_end)
                    ext_frame_end = Math.min(ext_frame_end, ev_k.frame_start);
            }

            ev.ext_frame_start = ext_frame_start;
            ev.ext_frame_end = ext_frame_end;
        }
    }
}

/**
 * Called every frame
 */
exports.update = function(timeline, elapsed) {

    // NOTE: need explicit start
    if (_start_time == -1)
        _start_time = timeline;

    for (var i = 0; i < _nla_arr.length; i++) {
        var nla = _nla_arr[i];

        process_nla_script(nla, timeline, elapsed, _start_time);

        var cf = calc_curr_frame(nla, timeline, _start_time);

        for (var j = 0; j < nla.objects.length; j++) {
            var obj = nla.objects[j];
            var nla_events = obj._nla_events;

            // NOTE: allow single-strip speakers to play again
            for (var k = 0; k < nla_events.length; k++) {
                var ev = nla_events[k];

                if (cf < nla.last_frame && m_sfx.is_speaker(obj))
                    ev.scheduled = false;
            }

            for (var k = 0; k < nla_events.length; k++) {
                var ev = nla_events[k];

                if (ev.ext_frame_start <= cf && cf < ev.ext_frame_end)
                    if (!ev.scheduled) {
                        process_event_start(obj, ev, cf, elapsed);

                        for (var l = 0; l < nla_events.length; l++)
                            if (nla_events[l] != ev)
                                nla_events[l].scheduled = false;

                        ev.scheduled = true;
                    }

                if (ev.scheduled)
                    process_event(obj, ev, cf, elapsed);
            }
        }

        nla.last_frame = cf;
    }
}

function process_nla_script(nla, timeline, elapsed, start_time) {

    if (!nla.script.length)
        return;

    if (nla.curr_script_slot >= nla.script.length) {
        if (nla.cyclic) {
            nla.curr_script_slot = 0;
        } else {
            // freeze
            nla.frame_offset -= cfg_ani.framerate * elapsed;
            return;
        }
    }


    var slot = nla.script[nla.curr_script_slot];

    switch (slot.type) {
    case "PLAY":
        var cf = calc_curr_frame(nla, timeline, start_time);

        if (!slot.in_play) {
            nla.frame_offset += (slot.frame_start - cf);
            slot.in_play = true;
            reset_nla_selection(nla, slot);
        } else {
            if (cf >= slot.frame_end) {
                slot.in_play = false;
                nla.curr_script_slot++;
                process_nla_script(nla, timeline, elapsed, start_time);
            }
        }
        break;
    case "JUMP":
        nla.curr_script_slot = slot.slot_idx;
        process_nla_script(nla, timeline, elapsed, start_time);
        break;
    case "SELECT":
    case "SELECT_PLAY":
        if (slot.sel_state > -1) {

            if (slot.type == "SELECT" || (slot.type == "SELECT_PLAY" && slot.sel_state == 0)) {
                nla.curr_script_slot = slot.sel_state ? slot.slot_idx_hit : slot.slot_idx_miss;
                slot.sel_state = -1;
                process_nla_script(nla, timeline, elapsed, start_time);
            } else {
                var cf = calc_curr_frame(nla, timeline, start_time);

                if (!slot.in_play) {
                    nla.frame_offset += (slot.frame_start - cf);
                    slot.in_play = true;
                    reset_nla_selection(nla, slot);
                } else {
                    if (cf >= slot.frame_end) {
                        slot.in_play = false;
                        nla.curr_script_slot = slot.slot_idx_hit;
                        slot.sel_state = -1;
                        process_nla_script(nla, timeline, elapsed, start_time);
                    }
                }
            }

        } else {
            // freeze
            nla.frame_offset -= cfg_ani.framerate * elapsed;
        }

        break;
    case "NOOP":
        nla.curr_script_slot++;
        process_nla_script(nla, timeline, elapsed, start_time);
        break;
    }
}

function reset_nla_selection(nla, curr_slot) {
    var nla_script = nla.script;

    for (var i = 0; i < nla_script.length; i++) {
        var slot = nla_script[i];
        if (slot != curr_slot)
            slot.sel_state = -1;
    }
}

function pause_scheduled_objects(objects) {
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var nla_events = obj._nla_events;
        for (var j = 0; j < nla_events.length; j++) {
            var ev = nla_events[j];
            if (ev.scheduled && !ev.paused) {
                process_event_pause(obj);
                ev.paused = true;
            }
        }
    }
}

function resume_scheduled_objects(objects) {
    for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        var nla_events = obj._nla_events;
        for (var j = 0; j < nla_events.length; j++) {
            var ev = nla_events[j];
            if (ev.paused) {
                process_event_resume(obj);
                ev.paused = false;
            }
        }
    }
}

function calc_curr_frame(nla, timeline, start_time) {

    var cf = (timeline - start_time) * cfg_ani.framerate - nla.frame_start +
            nla.frame_offset;
    if (nla.cyclic) {
        var stride = nla.frame_end - nla.frame_start + 1;
        cf %= stride;
    }
    cf += nla.frame_start;

    return cf;
}

function process_event_start(obj, ev, frame, elapsed) {

    if (m_particles.has_particles(obj) && m_particles.has_anim_particles(obj)) {
        m_anim.apply_def(obj);
        m_anim.set_behavior(obj, m_anim.AB_FINISH_STOP, m_anim.SLOT_0);
    } else if (m_util.is_armature(obj) || m_util.is_mesh(obj) || m_cam.is_camera(obj)) {
        m_anim.apply(obj, ev.action, m_anim.SLOT_0);
        // NOTE: should not be required
        m_anim.set_behavior(obj, m_anim.AB_FINISH_STOP, m_anim.SLOT_0);
    } else if (m_sfx.is_speaker(obj)) {
        // TODO: speakers are special
        var when = (ev.frame_start - frame) / cfg_ani.framerate;
        var duration = (ev.frame_end - ev.frame_start) / cfg_ani.framerate;
        m_sfx.play(obj, when, duration);
    }
}

function process_event(obj, ev, frame, elapsed) {

    if ((m_particles.has_particles(obj) && m_particles.has_anim_particles(obj)) ||
            m_util.is_armature(obj) || m_util.is_mesh(obj) ||
            m_cam.is_camera(obj)) {
        var init_anim_frame = frame - ev.frame_start + ev.action_frame_start;
        m_anim.set_current_frame_float(obj, init_anim_frame, m_anim.SLOT_0);
        m_anim.update_object_animation(obj, 0, m_anim.SLOT_0);
    }
}


exports.cleanup = function() {
    _nla_arr.length = 0;
    _start_time = -1;
}

/**
 * Convert NLA tracks to events
 */
function get_nla_events(nla_tracks) {

    var nla_events = [];

    for (var i = 0; i < nla_tracks.length; i++) {
        var track = nla_tracks[i];

        var strips = track["strips"];
        if (!strips)
            continue;

        for (var j = 0; j < strips.length; j++) {
            var strip = strips[j];

            var ev = {
                frame_start: strip["frame_start"],
                frame_end: strip["frame_end"],
                scheduled: false,
                action: strip["action"] ? strip["action"]["name"] : null,
                action_frame_start: strip["action_frame_start"],
                action_frame_end: strip["action_frame_end"],
                ext_frame_start: 0,
                ext_frame_end: 0
            };

            nla_events.push(ev);
        }
    }
    return nla_events;
}

exports.has_nla = function(obj) {
    var adata = obj["animation_data"];
    if (adata && adata["nla_tracks"].length)
        return true;
    else
        return false;
}

}
