import {
  ArrowLeft,
  Books,
  FileText,
  FolderOpen,
  MagnifyingGlass,
  X,
} from "@phosphor-icons/react";
import { useAtomValue } from "jotai";
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseRecord,
} from "@tagent/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@tagent/ui";
import { useEffect, useMemo, useState } from "react";
import { knowledgeBaseSidebarAtom } from "../../atoms/knowledge-base";
import { cn } from "../../lib/utils";
import { KIND_CREATE_OPTIONS, kindShortLabel } from "./kb-document-templates";

export const BASE_SELECT_EVENT = "tagent:knowledge-sidebar-select-base";
export const NEW_BASE_EVENT = "tagent:knowledge-sidebar-new-base";
export const BASE_BACK_EVENT = "tagent:knowledge-sidebar-back";
export const DOCUMENT_SELECT_EVENT = "tagent:knowledge-sidebar-select-document";
export const NEW_DOCUMENT_EVENT = "tagent:knowledge-sidebar-new-document";
export const REMOVE_SOURCE_EVENT = "tagent:knowledge-sidebar-remove-source";

function emit(name: string, detail: Record<string, string>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function documentSummary(document: KnowledgeBaseDocument): string {
  return document.content.replace(/\s+/g, " ").slice(0, 72) || "空文档";
}

function documentTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

export function KnowledgeBaseSidebar(): JSX.Element {
  const state = useAtomValue(knowledgeBaseSidebarAtom);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setQuery("");
  }, [state.mode, state.mode === "documents" ? state.knowledgeBaseId : ""]);

  const baseItems = state.mode === "bases" ? state.items : [];
  const documentItems = state.mode === "documents" ? state.documents : [];
  const filteredBases = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value
      ? baseItems.filter(
          (item) =>
            item.name.toLowerCase().includes(value) ||
            (item.description ?? "").toLowerCase().includes(value),
        )
      : baseItems;
  }, [baseItems, query]);
  const filteredDocuments = useMemo(() => {
    const value = query.trim().toLowerCase();
    return value
      ? documentItems.filter(
          (document) =>
            document.title.toLowerCase().includes(value) ||
            document.content.toLowerCase().includes(value),
        )
      : documentItems;
  }, [documentItems, query]);

  if (state.mode === "documents") {
    return (
      <div className="app-sidebar-body flex h-full min-h-0 flex-col">
        <div className="side-title">
          <button
            type="button"
            className="label min-w-0 cursor-pointer border-0 bg-transparent text-left"
            onClick={() => emit(BASE_BACK_EVENT, {})}
            aria-label="返回知识库列表"
          >
            <span className="zh flex items-center gap-1.5">
              <ArrowLeft size={13} />
              <span>知识库</span>
            </span>
            <span className="en">Knowledge</span>
          </button>
          <span className="title-actions">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="pill-new"
                  aria-label="新建文档"
                >
                  新建
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52 p-1.5">
                {KIND_CREATE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.kind}
                    onSelect={() =>
                      emit(NEW_DOCUMENT_EVENT, { kind: option.kind })
                    }
                  >
                    <span className="flex-1">{option.label}</span>
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {option.description}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
        <SidebarSearch
          value={query}
          onChange={setQuery}
          placeholder="搜索文档…"
          ariaLabel="搜索文档"
        />
        <div className="side-scroll scrollbar-thin">
          {state.loading ? (
            <SidebarHint>正在加载文档…</SidebarHint>
          ) : filteredDocuments.length === 0 ? (
            <SidebarHint>
              {query ? "没有匹配的文档。" : "暂无文档，点击“新建”创建一篇。"}
            </SidebarHint>
          ) : (
            <ul className="flex flex-col">
              {filteredDocuments.map((document) => (
                <DocumentRow
                  key={document.id}
                  document={document}
                  active={document.id === state.activeId}
                  onSelect={() =>
                    emit(DOCUMENT_SELECT_EVENT, { documentId: document.id })
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-sidebar-body flex h-full min-h-0 flex-col">
      <div className="side-title">
        <span className="label">
          <span className="zh">知识库</span>
          <span className="en">Knowledge</span>
        </span>
        <span className="title-actions">
          <button
            type="button"
            className="pill-new"
            onClick={() => emit(NEW_BASE_EVENT, {})}
            aria-label="新建知识库"
          >
            新建
          </button>
        </span>
      </div>
      <SidebarSearch
        value={query}
        onChange={setQuery}
        placeholder="搜索知识库…"
        ariaLabel="搜索知识库"
      />
      <div className="side-scroll scrollbar-thin">
        {state.loading ? (
          <SidebarHint>正在加载知识库…</SidebarHint>
        ) : filteredBases.length === 0 ? (
          <SidebarHint>
            {query ? "没有匹配的知识库。" : "暂无知识库，点击顶部“新建”创建。"}
          </SidebarHint>
        ) : (
          <ul className="flex flex-col">
            {filteredBases.map((item) => (
              <BaseRow
                key={item.id}
                item={item}
                active={item.id === state.selectedId}
                onSelect={() =>
                  emit(BASE_SELECT_EVENT, { knowledgeBaseId: item.id })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SidebarSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}): JSX.Element {
  return (
    <div className="side-head">
      <div className="search">
        <MagnifyingGlass size={13} weight="regular" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={ariaLabel}
        />
      </div>
    </div>
  );
}

function SidebarHint({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function BaseRow({
  item,
  active,
  onSelect,
}: {
  item: KnowledgeBaseRecord;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <li className={cn("row knowledge-row", active && "is-open")}>
      <button
        type="button"
        className="body w-full text-left"
        onClick={onSelect}
      >
        <div className="title">
          <Books size={14} className="shrink-0 text-muted-foreground" />
          <span className="t">{item.name}</span>
        </div>
      </button>
    </li>
  );
}

function DocumentRow({
  document,
  active,
  onSelect,
}: {
  document: KnowledgeBaseDocument;
  active: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <li className={cn("row knowledge-row", active && "is-open")}>
      <button
        type="button"
        className="body w-full text-left"
        onClick={onSelect}
      >
        <div className="title">
          <FileText size={14} className="shrink-0 text-muted-foreground" />
          <span className="t">{document.title}</span>
        </div>
        <div className="meta">
          <span
            className="m shrink-0 rounded-full border border-border/40 bg-muted/40 px-1.5"
            title={kindShortLabel(document.kind)}
          >
            {kindShortLabel(document.kind)}
          </span>
          <span className="m summary">{documentSummary(document)}</span>
          <span className="m time">{documentTime(document.updatedAt)}</span>
        </div>
      </button>
    </li>
  );
}
