// Source limitations are informational diagnostics, not failed scan targets.
const descriptions = {
  activityRecords: ['源工具活动已保留为记录文本', 'Source activity retained as record text'],
  compactionSummaryMissing: ['源压缩事件缺少摘要正文', 'Source compaction events have no summary text'],
  attachmentMetadata: ['源附件仅有元数据，未恢复图片字节', 'Source attachments contain metadata without recovered bytes'],
  emptyReasoning: ['源推理记录没有可恢复正文', 'Source reasoning records contain no recoverable text'],
  missingToolResults: ['源工具活动缺少原始输出', 'Source tool activities have no original output'],
  'rollout-droppedMalformedArgs': ['部分源工具参数无法转为标准JSON，已报告', 'Some source tool arguments could not be normalized'],
  'rollout-secrets': ['源记录含敏感信息特征，未在提示中展示内容', 'Potential secrets detected; values are not displayed'],
  'session-body-unavailable': ['会话来源正文不可用', 'Source conversation body unavailable'],
  'body-missing': ['会话来源正文缺失', 'Source conversation body missing'],
}
export function codexPanelWarnings(result, codexHome) {
  const groups = new Map(), failures = []
  const visit = (warning, sourceId) => {
    if (Array.isArray(warning.warnings)) { for (const child of warning.warnings) visit(child, warning.sourceId || sourceId); return }
    const code = warning.code || warning.reason
    const description = descriptions[code]
    if (!description) {
      failures.push({ ...warning, severity: 'error', format: 'codex', target: warning.path || codexHome,
        error: warning.error || warning.message || code || 'Unknown Codex scan diagnostic' })
      return
    }
    const group = groups.get(code) || { code, count: 0, sources: new Set() }
    group.count += Number.isFinite(warning.count) ? warning.count : 1
    if (sourceId || warning.id || warning.sessionId) group.sources.add(sourceId || warning.id || warning.sessionId)
    groups.set(code, group)
  }
  for (const warning of result?.warnings || []) visit(warning, warning.sourceId)
  // The loader already reports unavailable bodies; avoid reporting the same missing record twice.
  if (!groups.has('session-body-unavailable')) for (const missing of result?.missing || []) visit({ ...missing, code: 'body-missing' }, missing.id)
  return [...failures, ...[...groups.values()].map((group) => ({ code: group.code, severity: 'info', format: 'codex', target: codexHome,
    count: group.count, sessions: group.sources.size, error: descriptions[group.code][0] + '：' + group.count + ' 项' + (group.sources.size ? '，涉及 ' + group.sources.size + ' 条会话' : ''),
    messageEn: descriptions[group.code][1] + ': ' + group.count + ' items' }))]
}
