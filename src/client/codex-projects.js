    // Codex project migration is deliberately separate from transcript discovery.
    function codexProjectInferredCount(project) {
      return (project.sessions || []).filter((session) => session.evidence && session.evidence.inferred === true).length;
    }
    function codexProjectRequest(codexHome, projectIds) {
      const body = { includeInferred: true };
      if (codexHome.trim()) body.codexHome = codexHome.trim();
      if (projectIds !== undefined) { body.projectIds = projectIds; body.preview = false; }
      return body;
    }
    function codexProjectDetails(value) {
      return typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }
    function CodexProjectsPanel() {
      const t = useTranslate();
      const colors = COLORS;
      const [root, setRoot] = useState("");
      const [scan, setScan] = useState(null);
      const [selected, setSelected] = useState(new Set());
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [result, setResult] = useState(null);
      const mounted = useRef(true);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const projects = scan && Array.isArray(scan.projects) ? scan.projects : [];
      const chosen = projects.filter((project) => selected.has(project.id));
      const sessionCount = chosen.reduce((sum, project) => sum + (project.sessions || []).length, 0);
      const request = async (mode) => {
        if (busy || (mode === "import" && chosen.length === 0)) return;
        setBusy(mode); setError(null); setResult(null);
        try {
          const response = await postJson("/api-import/codex-projects/" + mode,
            codexProjectRequest(root, mode === "import" ? chosen.map((project) => project.id) : undefined));
          if (!response.ok) throw new Error(response.error || t("codexProjects.error"));
          if (!mounted.current) return;
          if (mode === "scan") {
            setScan(response.data);
            setSelected(new Set((response.data.projects || []).map((project) => project.id)));
          } else setResult(response.data);
        } catch (err) {
          if (mounted.current) setError(errorText(err));
        } finally {
          if (mounted.current) setBusy(null);
        }
      };
      const buttonStyle = { ...STYLES.toolBtn, padding: "7px 10px" };
      const detailStyle = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: "8px 0", fontSize: "12px" };
      const warningItems = [...(scan && Array.isArray(scan.warnings) ? scan.warnings : []),
        ...(scan && Array.isArray(scan.missing) ? scan.missing : []),
        ...(result && Array.isArray(result.warnings) ? result.warnings : [])];
      const failures = result && Array.isArray(result.results)
        ? result.results.filter((item) => item.status === "failed" || item.error || item.ok === false) : [];
      return h("section", { "aria-label": t("codexProjects.tab"), style: {
        padding: "14px", overflowY: "auto", flex: 1, minHeight: 0, color: colors.text,
      } },
        h("p", { style: { margin: "0 0 12px", fontSize: "13px", lineHeight: 1.6, color: colors.dim } }, t("codexProjects.intro")),
        h("label", { style: { display: "block", fontSize: "12px", marginBottom: "5px" } }, t("codexProjects.root"),
          h("input", { type: "text", value: root, disabled: !!busy, placeholder: t("codexProjects.auto"),
            style: { ...STYLES.searchInput, width: "100%", boxSizing: "border-box", marginTop: "5px" },
            onChange: (event) => { setRoot(event.target.value); setScan(null); setSelected(new Set()); setResult(null); setError(null); } })),
        h("button", { type: "button", disabled: !!busy, style: buttonStyle, onClick: () => request("scan") }, t("codexProjects.scan")),
        busy && h("p", { role: "status", "aria-live": "polite", style: detailStyle }, t("codexProjects." + (busy === "scan" ? "scanning" : "importing"))),
        error && h("p", { role: "alert", style: { ...detailStyle, color: colors.error } }, error),
        scan && projects.length === 0 && h("p", { style: detailStyle }, t("codexProjects.empty")),
        projects.length > 0 && h(React.Fragment, null,
          h("div", { style: { display: "flex", gap: "8px", margin: "12px 0" } },
            h("button", { type: "button", disabled: !!busy, style: buttonStyle, onClick: () => setSelected(new Set(projects.map((project) => project.id))) }, t("selectAll")),
            h("button", { type: "button", disabled: !!busy, style: buttonStyle, onClick: () => setSelected(new Set()) }, t("deselectAll"))),
          h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" } },
            h("thead", null, h("tr", null,
              h("th", { scope: "col", style: { textAlign: "left", padding: "6px" } }, t("codexProjects.project")),
              h("th", { scope: "col" }, t("codexProjects.sessions")),
              h("th", { scope: "col", title: t("codexProjects.inferredHint") }, t("codexProjects.inferred")))),
            h("tbody", null, ...projects.map((project) => h("tr", { key: project.id, style: { borderTop: "1px solid " + colors.border } },
              h("td", { style: { padding: "8px 4px", overflowWrap: "anywhere" } },
                h("label", null, h("input", { type: "checkbox", checked: selected.has(project.id), disabled: !!busy,
                  onChange: () => setSelected((previous) => { const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; }) }), " ", project.name),
                h("div", { style: { color: colors.dim, marginTop: "3px" } }, project.cwd || ""),
                h("details", { style: { marginTop: "5px" } }, h("summary", null, t("count.sessions", { n: (project.sessions || []).length })),
                  h("ul", { style: { paddingLeft: "18px", maxHeight: "180px", overflowY: "auto" } }, ...(project.sessions || []).map((session) =>
                    h("li", { key: session.id, style: { margin: "4px 0" } }, session.title || t("noTitle"),
                      session.evidence && session.evidence.inferred && h("span", { title: t("codexProjects.inferredHint"), style: { color: colors.dim } }, " · " + t("codexProjects.inferred"))))))),
              h("td", { style: { textAlign: "center" } }, (project.sessions || []).length),
              h("td", { style: { textAlign: "center" }, title: t("codexProjects.inferredHint") }, codexProjectInferredCount(project)))))),
          h("p", { style: detailStyle }, t("codexProjects.selection", { projects: chosen.length, sessions: sessionCount })),
          h("button", { type: "button", disabled: !!busy || !sessionCount, style: buttonStyle, onClick: () => request("import") }, t("codexProjects.import"))),
        result && h("div", { role: "status", "aria-live": "polite", style: { marginTop: "14px" } },
          h("p", { style: detailStyle }, t("codexProjects.result", { scanned: result.scanned || 0, imported: result.imported || 0,
            skipped: result.alreadyImported || 0, failed: result.failed || 0 })),
          h("details", { open: true }, h("summary", null, t("codexProjects.verification")),
            h("p", { style: detailStyle }, result.verification && result.verification.supported === true && result.verification.verified === true ? t("codexProjects.verified") : t("codexProjects.review")),
            h("pre", { style: detailStyle }, codexProjectDetails(result.verification || {})))),
        failures.length > 0 && h("details", { open: true }, h("summary", null, t("codexProjects.failures")),
          h("pre", { style: detailStyle }, failures.map(codexProjectDetails).join("\n"))),
        warningItems.length > 0 && h("details", { open: true, style: { marginTop: "12px" } },
          h("summary", null, t("codexProjects.warnings") + " (" + warningItems.length + ")"),
          h("pre", { style: detailStyle }, warningItems.map(codexProjectDetails).join("\n"))));
    }
