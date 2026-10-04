// lib/room-presence.mjs — Multi-Participant Shared Voice Room & Live Presence Coordinator (voicebox-beads-jagv).
//
// Coordinates live multi-participant room presence ("Here, together"):
//   1. Participant join, heartbeat, and leave with automatic TTL expiry pruning.
//   2. Collaborative turn-taking floor lock (requestFloor / releaseFloor) with automatic release on expiry.
//   3. Bounded shared caption and spoken-turn ring buffer across connected operators and agents.

export const DEFAULT_PRESENCE_TTL_MS = 45000;

export function createRoomPresenceCoordinator({
  ttlMs = DEFAULT_PRESENCE_TTL_MS,
  maxCaptions = 100,
} = {}) {
  const participants = new Map();
  let floorHolderId = null;
  const sharedCaptions = [];
  let generatedParticipantSeq = 0;

  function pruneExpired(now = Date.now()) {
    for (const [id, participant] of participants.entries()) {
      if (now - participant.lastSeenAt > ttlMs) {
        participants.delete(id);
        if (floorHolderId === id) {
          floorHolderId = null;
        }
      }
    }
    if (floorHolderId && !participants.has(floorHolderId)) {
      floorHolderId = null;
    }
  }

  function snapshot(now = Date.now()) {
    pruneExpired(now);
    return {
      ok: true,
      count: participants.size,
      floorHolderId,
      activeSpeaker: floorHolderId ? (participants.get(floorHolderId) ?? null) : null,
      participants: [...participants.values()],
      sharedCaptions: [...sharedCaptions],
    };
  }

  function appendCaptionEntry({
    participantId = "agent",
    speaker = "Voicebox",
    text = "",
    kind = "caption",
    now = Date.now(),
  } = {}) {
    const entry = {
      id: `cap_${now}_${sharedCaptions.length + 1}`,
      participantId,
      speaker,
      text: String(text).trim(),
      kind,
      timestamp: new Date(now).toISOString(),
    };
    sharedCaptions.push(entry);
    while (sharedCaptions.length > maxCaptions) {
      sharedCaptions.shift();
    }
    return entry;
  }

  function joinParticipant({
    participantId,
    name = "Operator",
    role = "participant",
    device = "browser",
    voiceState = "off",
    activeFile = null,
    now = Date.now(),
  } = {}) {
    pruneExpired(now);
    const id =
      typeof participantId === "string" && participantId.trim()
        ? participantId.trim()
        : `peer_${now}_${++generatedParticipantSeq}`;
    const existing = participants.get(id);
    const participant = {
      participantId: id,
      name: typeof name === "string" && name.trim() ? name.trim() : existing?.name ?? "Operator",
      role: typeof role === "string" && role.trim() ? role.trim() : existing?.role ?? "participant",
      device: typeof device === "string" && device.trim() ? device.trim() : existing?.device ?? "browser",
      voiceState:
        typeof voiceState === "string" && voiceState.trim()
          ? voiceState.trim()
          : existing?.voiceState ?? "off",
      activeFile: activeFile !== undefined ? activeFile : (existing?.activeFile ?? null),
      joinedAt: existing?.joinedAt ?? now,
      lastSeenAt: now,
    };
    participants.set(id, participant);
    return {
      ok: true,
      participant,
      snapshot: snapshot(now),
    };
  }

  function heartbeatParticipant(
    participantId,
    { name, voiceState, activeFile, caption, now = Date.now() } = {},
  ) {
    pruneExpired(now);
    const id =
      typeof participantId === "string" && participantId.trim()
        ? participantId.trim()
        : `peer_${now}_${++generatedParticipantSeq}`;
    const existing = participants.get(id) ?? {
      participantId: id,
      name: "Operator",
      role: "participant",
      device: "browser",
      voiceState: "off",
      activeFile: null,
      joinedAt: now,
      lastSeenAt: now,
    };
    const participant = {
      ...existing,
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      ...(typeof voiceState === "string" && voiceState.trim() ? { voiceState: voiceState.trim() } : {}),
      ...(activeFile !== undefined ? { activeFile } : {}),
      lastSeenAt: now,
    };
    participants.set(id, participant);
    if (typeof caption === "string" && caption.trim()) {
      appendCaptionEntry({
        participantId: id,
        speaker: participant.name,
        text: caption,
        kind: "caption",
        now,
      });
    }
    return {
      ok: true,
      participant,
      snapshot: snapshot(now),
    };
  }

  function leaveParticipant(participantId, { now = Date.now() } = {}) {
    const id = typeof participantId === "string" ? participantId.trim() : "";
    if (id) {
      participants.delete(id);
      if (floorHolderId === id) {
        floorHolderId = null;
      }
    }
    return {
      ok: true,
      removed: true,
      snapshot: snapshot(now),
    };
  }

  function requestFloor(participantId, { now = Date.now() } = {}) {
    pruneExpired(now);
    const id = typeof participantId === "string" ? participantId.trim() : "";
    if (!id) {
      return {
        ok: false,
        refused: "invalid-participant",
        why: "participantId is required to request the floor.",
      };
    }
    if (floorHolderId && floorHolderId !== id && participants.has(floorHolderId)) {
      return {
        ok: false,
        refused: "floor-busy",
        holderId: floorHolderId,
        why: `Floor is currently held by ${participants.get(floorHolderId)?.name || floorHolderId}.`,
      };
    }
    const existing = participants.get(id) ?? {
      participantId: id,
      name: "Operator",
      role: "participant",
      device: "browser",
      voiceState: "listening",
      activeFile: null,
      joinedAt: now,
      lastSeenAt: now,
    };
    const updated = {
      ...existing,
      voiceState: "listening",
      lastSeenAt: now,
    };
    participants.set(id, updated);
    floorHolderId = id;
    return {
      ok: true,
      holderId: floorHolderId,
      snapshot: snapshot(now),
    };
  }

  function releaseFloor(participantId, { now = Date.now() } = {}) {
    pruneExpired(now);
    const id = typeof participantId === "string" ? participantId.trim() : "";
    if (!id || floorHolderId === id) {
      if (floorHolderId && participants.has(floorHolderId)) {
        const holder = participants.get(floorHolderId);
        participants.set(floorHolderId, {
          ...holder,
          voiceState: "off",
          lastSeenAt: now,
        });
      }
      floorHolderId = null;
    }
    return {
      ok: true,
      holderId: floorHolderId,
      snapshot: snapshot(now),
    };
  }

  function recordSharedCaption({
    participantId = "agent",
    speaker = "Voicebox",
    text = "",
    kind = "caption",
    now = Date.now(),
  } = {}) {
    const entry = appendCaptionEntry({ participantId, speaker, text, kind, now });
    return {
      ok: true,
      entry,
      snapshot: snapshot(now),
    };
  }

  return {
    joinParticipant,
    heartbeatParticipant,
    leaveParticipant,
    requestFloor,
    releaseFloor,
    recordSharedCaption,
    snapshot,
  };
}
