/**
 * KbCitationBar — 一轮助手回答下方的「可点击来源芯片」条（P1-2 §B）
 *
 * 数据由 {@link collectTurnKbCitations} 从过程链 kb_search 结果解析得到。
 * - document 芯片：BookOpen + 标题；点击派发 {@link OPEN_KB_DOCUMENT_EVENT}，由 App.tsx
 *   切到知识库 rail 并选中该库 + 文档。
 * - directory 芯片：FileText + 相对路径；tooltip 显示绝对路径；本轮不可点（仅展示来源）。
 *
 * 无 citations 不渲染。live 未完成时已有命中也会展示（过程链里已完成的 kb_search）。
 *
 * @see docs/dev/knowledge-base/KB-P1-2-CITATIONS-brief.md §B
 */
import { BookOpen, FileText } from "@phosphor-icons/react";
import { AppTooltip } from "@tagent/ui";
import { cn } from "../../lib/utils";
import { OPEN_KB_DOCUMENT_EVENT, type KbCitation } from "./kb-citations";

interface KbCitationBarProps {
  citations: KbCitation[];
  /** 额外类名（挂载点微调间距） */
  className?: string;
}

export function KbCitationBar({
  citations,
  className,
}: KbCitationBarProps): JSX.Element | null {
  if (!citations.length) return null;
  return (
    <div className={cn("kb-citation-bar", className)}>
      <span className="kb-citation-bar__label">来源</span>
      <div className="kb-citation-bar__chips">
        {citations.map((c, i) => (
          <KbCitationChip
            key={`${c.source}:${c.documentId ?? c.relativePath ?? c.absolutePath ?? i}`}
            citation={c}
          />
        ))}
      </div>
    </div>
  );
}

function KbCitationChip({ citation }: { citation: KbCitation }): JSX.Element {
  if (citation.source === "document") {
    return <DocumentChip citation={citation} />;
  }
  return <DirectoryChip citation={citation} />;
}

/**
 * 文档芯片：有 knowledgeBaseId + documentId 才可点（派发打开事件）；
 * 缺关键字段时退化为不可点的展示芯片，避免点了无法导航。
 */
function DocumentChip({ citation }: { citation: KbCitation }): JSX.Element {
  const clickable = Boolean(citation.knowledgeBaseId && citation.documentId);
  const tooltip = clickable
    ? `打开文档：${citation.title}`
    : citation.title;
  const chip = (
    <span
      className={cn(
        "kb-citation-chip",
        "kb-citation-chip--document",
        clickable && "kb-citation-chip--clickable",
      )}
    >
      <BookOpen size={12} className="shrink-0" aria-hidden />
      <span className="kb-citation-chip__text">{citation.title}</span>
    </span>
  );
  if (!clickable) {
    return <AppTooltip label={tooltip}>{chip}</AppTooltip>;
  }
  return (
    <AppTooltip label={tooltip}>
      <button
        type="button"
        className={cn(
          "kb-citation-chip",
          "kb-citation-chip--document",
          "kb-citation-chip--clickable",
        )}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent(OPEN_KB_DOCUMENT_EVENT, {
              detail: {
                knowledgeBaseId: citation.knowledgeBaseId,
                documentId: citation.documentId,
              },
            }),
          )
        }
      >
        <BookOpen size={12} className="shrink-0" aria-hidden />
        <span className="kb-citation-chip__text">{citation.title}</span>
      </button>
    </AppTooltip>
  );
}

/** 目录芯片：展示相对路径，tooltip 显示绝对路径；本轮不可点。 */
function DirectoryChip({ citation }: { citation: KbCitation }): JSX.Element {
  const label = citation.relativePath ?? citation.title;
  const tooltip = citation.absolutePath && citation.absolutePath !== label
    ? citation.absolutePath
    : label;
  return (
    <AppTooltip label={tooltip} multiline>
      <span
        className={cn(
          "kb-citation-chip",
          "kb-citation-chip--directory",
        )}
      >
        <FileText size={12} className="shrink-0" aria-hidden />
        <span className="kb-citation-chip__text">{label}</span>
      </span>
    </AppTooltip>
  );
}
