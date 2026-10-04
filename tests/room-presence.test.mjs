// tests/room-presence.test.mjs — Unit tests for Multi-Participant Shared Voice Room & Live Presence Coordinator (voicebox-beads-jagv).
//
//   node --test tests/room-presence.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRESENCE_TTL_MS,
  createRoomPresenceCoordinator,
} from "../lib/room-presence.mjs";

test("joinParticipant, heartbeatParticipant, and leaveParticipant track multi-participant state", () => {
  const coordinator = createRoomPresenceCoordinator({ ttlMs: 10000, maxCaptions: 10 });

  assert.equal(DEFAULT_PRESENCE_TTL_MS, 45000);

  // Join first participant
  const joinA = coordinator.joinParticipant({
    participantId: "peer-alice",
    name: "Alice",
    role: "host",
    device: "desktop",
    voiceState: "off",
    activeFile: "README.md",
    now: 1000,
  });
  assert.equal(joinA.ok, true);
  assert.equal(joinA.participant.participantId, "peer-alice");
  assert.equal(joinA.participant.name, "Alice");
  assert.equal(joinA.participant.role, "host");
  assert.equal(joinA.participant.device, "desktop");
  assert.equal(joinA.participant.activeFile, "README.md");
  assert.equal(joinA.snapshot.count, 1);

  // Join second participant (omitting participantId generates a unique one)
  const joinB = coordinator.joinParticipant({
    name: "Bob",
    device: "mobile",
    now: 1500,
  });
  assert.equal(joinB.ok, true);
  assert.ok(joinB.participant.participantId);
  assert.equal(joinB.participant.name, "Bob");
  assert.equal(joinB.snapshot.count, 2);

  // Heartbeat updates fields and appends caption when provided
  const hbA = coordinator.heartbeatParticipant("peer-alice", {
    voiceState: "speaking",
    activeFile: "server.mjs",
    caption: "Reviewing the presence routes now.",
    now: 2000,
  });
  assert.equal(hbA.ok, true);
  assert.equal(hbA.participant.voiceState, "speaking");
  assert.equal(hbA.participant.activeFile, "server.mjs");
  assert.equal(hbA.participant.lastSeenAt, 2000);
  assert.equal(hbA.snapshot.sharedCaptions.length, 1);
  assert.equal(hbA.snapshot.sharedCaptions[0].speaker, "Alice");
  assert.equal(hbA.snapshot.sharedCaptions[0].text, "Reviewing the presence routes now.");

  // Leave removes participant
  const leaveA = coordinator.leaveParticipant("peer-alice", { now: 2500 });
  assert.equal(leaveA.ok, true);
  assert.equal(leaveA.removed, true);
  assert.equal(leaveA.snapshot.count, 1);
  assert.equal(leaveA.snapshot.participants[0].name, "Bob");
});

test("automatic TTL expiry prunes stale participants and releases floor lock", () => {
  const coordinator = createRoomPresenceCoordinator({ ttlMs: 5000 });

  coordinator.joinParticipant({
    participantId: "peer-alice",
    name: "Alice",
    now: 1000,
  });
  coordinator.joinParticipant({
    participantId: "peer-bob",
    name: "Bob",
    now: 1000,
  });

  // Alice takes the floor at t=1500
  const floorRes = coordinator.requestFloor("peer-alice", { now: 1500 });
  assert.equal(floorRes.ok, true);
  assert.equal(floorRes.holderId, "peer-alice");
  assert.equal(floorRes.snapshot.activeSpeaker?.participantId, "peer-alice");

  // Bob heartbeats at t=4000; Alice does not
  coordinator.heartbeatParticipant("peer-bob", { now: 4000 });

  // At t=7000, Alice (lastSeenAt=1500, age=5500 > 5000) is pruned and floor is released
  const snap = coordinator.snapshot(7000);
  assert.equal(snap.count, 1);
  assert.equal(snap.participants[0].participantId, "peer-bob");
  assert.equal(snap.floorHolderId, null);
  assert.equal(snap.activeSpeaker, null);

  // Bob can now claim the floor immediately
  const bobFloor = coordinator.requestFloor("peer-bob", { now: 7100 });
  assert.equal(bobFloor.ok, true);
  assert.equal(bobFloor.holderId, "peer-bob");
});

test("collaborative turn-taking floor control enforces floor-busy and releaseFloor", () => {
  const coordinator = createRoomPresenceCoordinator({ ttlMs: 30000 });

  coordinator.joinParticipant({ participantId: "peer-a", name: "Operator A", now: 1000 });
  coordinator.joinParticipant({ participantId: "peer-b", name: "Operator B", now: 1000 });

  // Participant A requests floor -> succeeds
  const claimA = coordinator.requestFloor("peer-a", { now: 1100 });
  assert.equal(claimA.ok, true);
  assert.equal(claimA.holderId, "peer-a");
  assert.equal(claimA.snapshot.floorHolderId, "peer-a");
  assert.equal(claimA.snapshot.activeSpeaker?.voiceState, "listening");

  // Participant A re-requesting floor is idempotent
  const reclaimA = coordinator.requestFloor("peer-a", { now: 1200 });
  assert.equal(reclaimA.ok, true);
  assert.equal(reclaimA.holderId, "peer-a");

  // Participant B requests floor while A holds it -> refused with floor-busy
  const claimBWhileBusy = coordinator.requestFloor("peer-b", { now: 1300 });
  assert.equal(claimBWhileBusy.ok, false);
  assert.equal(claimBWhileBusy.refused, "floor-busy");
  assert.equal(claimBWhileBusy.holderId, "peer-a");
  assert.match(claimBWhileBusy.why, /Operator A/);

  // Participant A releases floor
  const relA = coordinator.releaseFloor("peer-a", { now: 1400 });
  assert.equal(relA.ok, true);
  assert.equal(relA.holderId, null);
  assert.equal(relA.snapshot.floorHolderId, null);
  assert.equal(relA.snapshot.activeSpeaker, null);
  const participantA = relA.snapshot.participants.find((p) => p.participantId === "peer-a");
  assert.equal(participantA?.voiceState, "off");

  // Participant B requests floor after release -> succeeds
  const claimBAfter = coordinator.requestFloor("peer-b", { now: 1500 });
  assert.equal(claimBAfter.ok, true);
  assert.equal(claimBAfter.holderId, "peer-b");
  assert.equal(claimBAfter.snapshot.activeSpeaker?.participantId, "peer-b");

  // Leaving while holding the floor automatically clears floorHolderId
  const leaveB = coordinator.leaveParticipant("peer-b", { now: 1600 });
  assert.equal(leaveB.snapshot.floorHolderId, null);
});

test("recordSharedCaption appends entries and bounds ring buffer to maxCaptions", () => {
  const coordinator = createRoomPresenceCoordinator({ maxCaptions: 3 });

  const c1 = coordinator.recordSharedCaption({
    participantId: "peer-1",
    speaker: "Alice",
    text: "  First turn  ",
    kind: "turn",
    now: 1000,
  });
  assert.equal(c1.ok, true);
  assert.equal(c1.entry.text, "First turn");
  assert.equal(c1.entry.kind, "turn");

  coordinator.recordSharedCaption({
    participantId: "agent",
    speaker: "Voicebox",
    text: "Second turn",
    now: 2000,
  });
  coordinator.recordSharedCaption({
    participantId: "peer-2",
    speaker: "Bob",
    text: "Third turn",
    now: 3000,
  });
  const c4 = coordinator.recordSharedCaption({
    participantId: "agent",
    speaker: "Voicebox",
    text: "Fourth turn",
    now: 4000,
  });

  assert.equal(c4.snapshot.sharedCaptions.length, 3);
  assert.deepEqual(
    c4.snapshot.sharedCaptions.map((c) => c.text),
    ["Second turn", "Third turn", "Fourth turn"],
  );
});
