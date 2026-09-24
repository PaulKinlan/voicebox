const button = document.getElementById("check");
const status = document.getElementById("status");
const list = document.getElementById("harnesses");
const scope = document.getElementById("scope");
function text(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.append(element);
  return element;
}
function tools(article, catalogue) {
  if (catalogue?.status !== "declared") {
    text(article, "h3", "Tools — unknown");
    text(article, "p", catalogue?.why ?? "No tool catalogue was reported. Unknown does not mean this harness has no tools.");
    return;
  }
  const details = document.createElement("details");
  details.className = "tool-catalogue";
  text(details, "summary", `Declared tools (${catalogue.tools.length})`);
  text(details, "p", `Source: ${catalogue.source}`);
  text(details, "p", `Scope: ${catalogue.scope}`);
  text(details, "p", "Host-supplied metadata, not a live session inspection. Tools may be disabled, changed or extended; this list grants no permission to run them.");
  if (catalogue.tools.length === 0) text(details, "p", "The host declared an empty list. This does not establish that the harness has no tools.");
  const descriptions = document.createElement("dl");
  for (const tool of catalogue.tools) {
    text(text(descriptions, "dt", ""), "code", tool.name);
    text(descriptions, "dd", tool.description);
  }
  details.append(descriptions);
  article.append(details);
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
      text(article, "p", row.delegation.ok ? `Voicebox delegation: ${row.delegation.mechanism ?? "allowed"}` : `Voicebox delegation: ${row.delegation.why}`);
      tools(article, row.toolCatalogue);
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
