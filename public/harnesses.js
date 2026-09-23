const button = document.getElementById("check");
const status = document.getElementById("status");
const list = document.getElementById("harnesses");
const scope = document.getElementById("scope");
function text(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.append(element);
}
button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Checking host programs…";
  try {
    const response = await fetch("/api/harnesses", { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const report = await response.json();
    if (!report.ok || !Array.isArray(report.entries)) throw new Error("invalid inventory response");
    list.replaceChildren();
    for (const row of report.entries) {
      const article = document.createElement("article");
      article.dataset.harness = row.id;
      text(article, "h2", `${row.name} — ${row.state}${row.version ? ` (${row.version})` : ""}`);
      text(article, "p", row.description);
      text(article, "p", row.why);
      text(article, "p", row.capabilities);
      article.dataset.delegationRefusal = row.delegation.refused ?? "none";
      text(article, "p", row.delegation.ok ? `Voicebox delegation: ${row.delegation.mechanism ?? "admitted"}` : `Voicebox delegation: ${row.delegation.why}`);
      list.append(article);
    }
    scope.textContent = `${report.scope}. ${report.note}`;
    status.textContent = `Observed ${report.observedAt}. Snapshot reused for up to 60 seconds.`;
  } catch (error) {
    status.textContent = `Inventory unavailable (${error.message}). Check the Voicebox server connection and retry. Any previous entries below are stale, not a fresh observation.`;
  } finally {
    button.disabled = false;
  }
});
