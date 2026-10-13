// public/presence-ui.mjs — Multi-participant live room presence & floor control UI.
//
// Manages participant roster rendering, heartbeats, floor lock requests,
// and turn-taking state in the shared room.

export function createPresenceUIController({
  documentObj = globalThis.document,
  stripEl,
  countEl,
  rosterEl,
  floorBtn,
  floorBadgeEl,
  localParticipantId = null,
  localName = "Operator",
  localRole = "host",
  pollIntervalMs = 8000,
} = {}) {
  let participantId =
    localParticipantId || `peer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  let currentSnapshot = {
    count: 1,
    floorHolderId: null,
    participants: [],
  };
  let heartbeatTimer = null;
  let pollTimer = null;
  let isRequesting = false;

  async function join() {
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "join",
          participantId,
          name: localName,
          role: localRole,
        }),
      });
      if (res.ok) {
        const snap = await res.json();
        render(snap);
      }
    } catch {}
  }

  async function heartbeat({ voiceState, activeFile } = {}) {
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "heartbeat",
          participantId,
          name: localName,
          voiceState,
          activeFile,
        }),
      });
      if (res.ok) {
        const snap = await res.json();
        render(snap);
      }
    } catch {}
  }

  async function fetchPresence() {
    try {
      const res = await fetch("/api/presence", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const snap = await res.json();
        render(snap);
      }
    } catch {}
  }

  async function requestFloor() {
    if (isRequesting) return;
    isRequesting = true;
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "requestFloor",
          participantId,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        render(data.snapshot);
      }
    } catch {} finally {
      isRequesting = false;
    }
  }

  async function releaseFloor() {
    if (isRequesting) return;
    isRequesting = true;
    try {
      const res = await fetch("/api/presence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "releaseFloor",
          participantId,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        render(data.snapshot);
      }
    } catch {} finally {
      isRequesting = false;
    }
  }

  async function toggleFloor() {
    if (currentSnapshot.floorHolderId === participantId) {
      await releaseFloor();
    } else {
      await requestFloor();
    }
  }

  function render(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    currentSnapshot = snapshot;
    const participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
    const count = participants.length;
    const hasFloor = snapshot.floorHolderId === participantId;
    const isFloorHeldByOther = Boolean(snapshot.floorHolderId && snapshot.floorHolderId !== participantId);

    // Keep UI completely hidden in solo mode when floor is not locked
    if (stripEl) {
      if (count <= 1 && !snapshot.floorHolderId) {
        stripEl.setAttribute("hidden", "");
      } else {
        stripEl.removeAttribute("hidden");
      }
    }

    if (countEl) {
      countEl.textContent = `${count} participant${count === 1 ? "" : "s"}`;
    }

    if (floorBadgeEl) {
      if (snapshot.floorHolderId) {
        floorBadgeEl.removeAttribute("hidden");
        const holder = participants.find((p) => p.participantId === snapshot.floorHolderId);
        floorBadgeEl.textContent = hasFloor ? "You hold the floor" : `Floor: ${holder?.name || snapshot.floorHolderId}`;
      } else {
        floorBadgeEl.setAttribute("hidden", "");
      }
    }

    if (floorBtn) {
      if (hasFloor) {
        floorBtn.textContent = "Release Floor";
        floorBtn.classList.add("active");
        floorBtn.disabled = false;
      } else if (isFloorHeldByOther) {
        const holder = participants.find((p) => p.participantId === snapshot.floorHolderId);
        floorBtn.textContent = `Floor held by ${holder?.name || "peer"}`;
        floorBtn.classList.remove("active");
        floorBtn.disabled = true;
      } else {
        floorBtn.textContent = "Request Floor";
        floorBtn.classList.remove("active");
        floorBtn.disabled = false;
      }
    }

    if (rosterEl && documentObj?.createElement) {
      rosterEl.replaceChildren();
      for (const p of participants) {
        const chip = documentObj.createElement("div");
        chip.className = "presence-chip";
        if (p.participantId === snapshot.floorHolderId) {
          chip.classList.add("has-floor");
        }
        chip.dataset.voice = p.voiceState || "off";

        const dot = documentObj.createElement("span");
        dot.className = "presence-chip-dot";
        dot.setAttribute("aria-hidden", "true");
        chip.append(dot);

        const nameSpan = documentObj.createElement("span");
        nameSpan.className = "presence-chip-name";
        const isSelf = p.participantId === participantId;
        nameSpan.textContent = isSelf ? `${p.name} (You)` : p.name;
        chip.append(nameSpan);

        if (p.activeFile) {
          const fileSpan = documentObj.createElement("span");
          fileSpan.className = "presence-chip-file";
          fileSpan.textContent = `· ${p.activeFile}`;
          chip.append(fileSpan);
        }

        rosterEl.append(chip);
      }
    }
  }

  function start() {
    void join();
    if (pollIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        void heartbeat();
      }, Math.max(10000, pollIntervalMs));
      pollTimer = setInterval(() => {
        void fetchPresence();
      }, Math.max(5000, pollIntervalMs / 2));
    }
    if (floorBtn) {
      floorBtn.addEventListener("click", () => void toggleFloor());
    }
  }

  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pollTimer) clearInterval(pollTimer);
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon("/api/presence", JSON.stringify({ action: "leave", participantId }));
      }
    } catch {}
  }

  return {
    start,
    stop,
    join,
    heartbeat,
    requestFloor,
    releaseFloor,
    toggleFloor,
    fetchPresence,
    render,
    getParticipantId: () => participantId,
    getSnapshot: () => currentSnapshot,
  };
}
