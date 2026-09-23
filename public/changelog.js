const status = document.getElementById("changelog-status");
const list = document.getElementById("commits");

async function loadChangelog() {
  try {
    const res = await fetch("/api/changelog", { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.commits)) throw new Error("invalid changelog response");

    if (data.commits.length === 0) {
      status.textContent = "No recent commits found.";
      return;
    }

    status.textContent = `Showing ${data.commits.length} recent commits:`;
    list.replaceChildren();

    for (const c of data.commits) {
      const li = document.createElement("li");
      li.className = "commit-card";

      const header = document.createElement("div");
      header.className = "commit-header";

      const link = document.createElement("a");
      link.className = "commit-sha";
      link.href = c.url || `https://github.com/PaulKinlan/voicebox/commit/${c.sha}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = c.shortSha || (c.sha ? c.sha.slice(0, 7) : "");
      header.append(link);

      const subject = document.createElement("span");
      subject.className = "commit-subject";
      subject.textContent = c.subject;
      header.append(subject);

      li.append(header);

      const meta = document.createElement("div");
      meta.className = "commit-meta";
      meta.textContent = `${c.author || "Unknown"} · ${c.date || ""}`;
      li.append(meta);

      list.append(li);
    }
  } catch (err) {
    status.replaceChildren();
    status.append(document.createTextNode(`Could not load local changelog (${err.message}). View `));
    const gh = document.createElement("a");
    gh.href = "https://github.com/PaulKinlan/voicebox/commits/main";
    gh.target = "_blank";
    gh.rel = "noopener noreferrer";
    gh.textContent = "all commits on GitHub";
    status.append(gh, document.createTextNode("."));
  }
}

loadChangelog();
