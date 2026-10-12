// Presence HTTP handlers. The host still owns the coordinator, auth wall, JSON body door,
// error boundary and /channel broadcast; only these two exact method/path routes live here.
export function createPresenceRoutes({ roomPresence, json, readJsonBody, answerOnce, broadcastChannel }) {
  return {
    "GET /api/presence": (_req, res) => json(res, 200, roomPresence.snapshot()),
    "POST /api/presence": async (req, res) => {
      const parsed = await readJsonBody(req, res);
      if (parsed === null || typeof parsed !== "object") {
        return json(res, 400, { ok: false, refused: "bad-request", why: "body must be JSON" });
      }
      return answerOnce(res, async () => {
        const {
          action = "heartbeat",
          participantId,
          name,
          role,
          device,
          voiceState,
          activeFile,
          caption,
          speaker,
          text,
          kind,
        } = parsed ?? {};
        let result;
        if (action === "join" || action === "joinParticipant") {
          result = roomPresence.joinParticipant({
            participantId,
            name,
            role,
            device,
            voiceState,
            activeFile,
          });
        } else if (action === "leave" || action === "leaveParticipant") {
          result = roomPresence.leaveParticipant(participantId);
        } else if (action === "requestFloor" || action === "request_floor") {
          result = roomPresence.requestFloor(participantId);
        } else if (action === "releaseFloor" || action === "release_floor") {
          result = roomPresence.releaseFloor(participantId);
        } else if (
          action === "recordSharedCaption" ||
          action === "record_caption" ||
          action === "caption"
        ) {
          result = roomPresence.recordSharedCaption({
            participantId,
            speaker: speaker ?? name,
            text: text ?? caption ?? "",
            kind,
          });
        } else {
          result = roomPresence.heartbeatParticipant(participantId, {
            name,
            voiceState,
            activeFile,
            caption: caption ?? text,
          });
        }
        broadcastChannel({ type: "presence", ...roomPresence.snapshot() });
        return json(res, result.ok === false ? 409 : 200, result);
      });
    },
  };
}
