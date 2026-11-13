    // Codex action metadata belongs to stock discovery rows, not a separate import flow.
    const CODEX_MIGRATION_ACTIONS = ["unchanged", "update", "conflict", "adoptable", "new", "ambiguous", "missing"];
    function codexMigrationAction(session) {
      return session && session.format === "codex" && CODEX_MIGRATION_ACTIONS.includes(session.migrationAction)
        ? session.migrationAction : null;
    }
    function codexMigrationActionLabel(session, t) {
      const action = codexMigrationAction(session);
      return action ? t("migration.action." + action) : "";
    }
    function codexMigrationTip(session, t) {
      const label = codexMigrationActionLabel(session, t);
      if (!label) return "";
      const reason = session.migrationReason || session.reason;
      return label + (typeof reason === "string" && reason ? " · " + reason : "")
        + (codexMigrationAction(session) === "conflict" ? "\n" + t("migration.conflictCopy") : "")
        + (session.existingSessionId ? "\n" + t("migration.existing", { id: session.existingSessionId }) : "");
    }
    function codexMigrationSummary(sessions, t) {
      const counts = Object.fromEntries(CODEX_MIGRATION_ACTIONS.map((action) => [action, 0]));
      for (const session of sessions || []) {
        const action = codexMigrationAction(session);
        if (action) counts[action]++;
      }
      return CODEX_MIGRATION_ACTIONS.filter((action) => counts[action] > 0)
        .map((action) => t("migration.action." + action) + " " + counts[action]).join(" · ");
    }
    function CodexMigrationSummary({ source, sessions, selected, t }) {
      if (source !== "codex") return null;
      const chosen = selected && selected.size ? [...selected.values()] : sessions;
      const summary = codexMigrationSummary(chosen, t);
      if (!summary) return null;
      return h("div", { role: "status", style: { padding: "9px 14px", borderBottom: "1px solid " + COLORS.border, color: COLORS.dim, fontSize: "12px", lineHeight: 1.6 } },
        h("div", null, t(selected && selected.size ? "migration.selected" : "migration.preview"), " · ", summary),
        h("div", null, t("migration.readOnly")));
    }
    function CodexMigrationBadge({ session, t }) {
      const action = codexMigrationAction(session);
      if (!action) return null;
      const warning = action === "conflict" || action === "ambiguous" || action === "missing";
      return h("span", { title: codexMigrationTip(session, t), "aria-label": codexMigrationActionLabel(session, t),
        style: { display: "inline-block", marginRight: "7px", fontSize: "10px", lineHeight: "16px", verticalAlign: "middle", color: warning ? COLORS.error : COLORS.dim } },
        codexMigrationActionLabel(session, t));
    }
