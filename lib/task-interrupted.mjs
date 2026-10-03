// Shared outcome: an executor ended without a confirmed task result, not a failed task.
export class TaskInterrupted extends Error {
  constructor(reason = "executor-ended-outcome-unknown", detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "TaskInterrupted";
    this.refused = reason;
    if (detail) this.detail = detail;
  }
}
