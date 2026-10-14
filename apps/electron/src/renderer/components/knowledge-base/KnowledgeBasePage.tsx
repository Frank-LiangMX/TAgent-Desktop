import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Plus,
  MagnifyingGlass,
  PencilSimple,
  Books,
  CaretDown,
  CheckCircle,
  DotsThreeVertical,
  DownloadSimple,
  FileArrowUp,
  FileText,
  FolderOpen,
  LinkSimple,
  Share,
  Trash,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseDocumentKind,
  KnowledgeBaseRecord,
} from "@tagent/shared";
import { parseWorkbenchTags, workbenchHasTag } from "@tagent/shared";
import {
  Button,
  Input,
  Textarea,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  MessageResponse,
} from "@tagent/ui";
import { cn } from "../../lib/utils";
import { browserApi } from "../../atoms/browser";
import {
  BASE_BACK_EVENT,
  BASE_SELECT_EVENT,
  NEW_BASE_EVENT,
  DOCUMENT_SELECT_EVENT,
  NEW_DOCUMENT_EVENT,
  REMOVE_SOURCE_EVENT,
} from "./KnowledgeBaseSidebar";
import {
  KIND_CREATE_OPTIONS,
  kindLabel,
  templateForKind,
} from "./kb-document-templates";

import { WorkbenchSelect } from "../workbench/WorkbenchSelect";
import {
  KnowledgeLibrary,
  documentExcerpt,
  knowledgeDate,
  knowledgeTopicCounts,
} from "./KnowledgeLibrary";
import {
  confirmKnowledgeLeave,
  KNOWLEDGE_LEAVE_EVENT,
  type KnowledgeNavigation,
} from "./knowledge-navigation";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function extractHttpUrl(raw: string): string {
  const embedded = raw.match(/https?:\/\/[^\s<>{}\]\)]+/i)?.[0];
  return (embedded ?? raw.trim()).replace(/[),.;!?，。；！？】》]+$/g, "");
}

const sourceProviderLabel = (
  provider: KnowledgeBaseDocument["sourceProvider"],
): string => {
  switch (provider) {
    case "wps":
      return "WPS 云文档";
    case "feishu":
      return "飞书云文档";
    case "google-drive":
      return "Google 云文档";
    default:
      return "云文档";
  }
};

export function KnowledgeBasePage({
  navigation,
}: {
  navigation?: KnowledgeNavigation;
}): JSX.Element {
  const [items, setItems] = useState<KnowledgeBaseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [libraryDocuments, setLibraryDocuments] = useState<
    KnowledgeBaseDocument[]
  >([]);
  const [requestedDocumentId, setRequestedDocumentId] = useState<string>();
  const handledNavigation = useRef<number>();
  const [documentsReady, setDocumentsReady] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setDocumentsReady(false);
    setError(null);
    try {
      setItems([...(await window.electronAPI.listKnowledgeBases())]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const [documentCountLoading, setDocumentCountLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (loading) {
      setLibraryDocuments([]);
      setDocumentCountLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (items.length === 0) {
      setLibraryDocuments([]);
      setDocumentCountLoading(false);
      setDocumentsReady(true);
      return () => {
        cancelled = true;
      };
    }
    setDocumentCountLoading(true);
    void Promise.all(
      items.map((item) =>
        window.electronAPI.listKnowledgeBaseDocuments({
          knowledgeBaseId: item.id,
        }),
      ),
    )
      .then((lists) => {
        if (!cancelled) {
          setLibraryDocuments(lists.flat());
          setDocumentsReady(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) {
          setDocumentCountLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [items, loading]);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  useEffect(() => {
    if (
      !navigation ||
      loading ||
      !documentsReady ||
      documentCountLoading ||
      handledNavigation.current === navigation.requestId
    )
      return;
    const baseId =
      navigation.knowledgeBaseId ??
      libraryDocuments.find((doc) => doc.id === navigation.documentId)
        ?.knowledgeBaseId;
    if (navigation.documentId && !baseId) {
      setError("找不到这篇知识文档，可能已被删除。");
    } else if (baseId && !items.some((item) => item.id === baseId)) {
      setError("找不到这篇文档所属的知识库。");
    } else {
      setSelectedId(baseId ?? null);
      setRequestedDocumentId(navigation.documentId);
    }
    handledNavigation.current = navigation.requestId;
  }, [
    navigation,
    loading,
    documentsReady,
    documentCountLoading,
    items,
    libraryDocuments,
  ]);
  useEffect(() => {
    const handleBaseSelect = (event: Event): void => {
      const knowledgeBaseId = (
        event as CustomEvent<{ knowledgeBaseId?: string }>
      ).detail?.knowledgeBaseId;
      if (knowledgeBaseId && confirmKnowledgeLeave()) {
        setRequestedDocumentId(undefined);
        setSelectedId(knowledgeBaseId);
      }
    };
    const handleNewBase = (): void => setDialogOpen(true);
    window.addEventListener(BASE_SELECT_EVENT, handleBaseSelect);
    window.addEventListener(NEW_BASE_EVENT, handleNewBase);
    return () => {
      window.removeEventListener(BASE_SELECT_EVENT, handleBaseSelect);
      window.removeEventListener(NEW_BASE_EVENT, handleNewBase);
    };
  }, []);

  const choosePaths = async () => {
    const selectedPaths = await window.electronAPI.openFolderDialog();
    if (selectedPaths.length) {
      setPaths((current) => [...new Set([...current, ...selectedPaths])]);
    }
  };
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await window.electronAPI.createKnowledgeBase({
        name: name.trim(),
        description: description.trim() || undefined,
        sourcePaths: paths,
      });
      setItems((current) => [created, ...current]);
      setDialogOpen(false);
      setName("");
      setDescription("");
      setPaths([]);
      setSelectedId(created.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const addSource = async (id: string) => {
    const selectedPaths = await window.electronAPI.openFolderDialog();
    if (!selectedPaths[0]) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electronAPI.addKnowledgeBaseSource({
        id,
        path: selectedPaths[0],
      });
      setItems((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const removeSource = async (id: string, sourceId: string) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.electronAPI.removeKnowledgeBaseSource({
        id,
        sourceId,
      });
      setItems((current) =>
        current.map((item) => (item.id === id ? updated : item)),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (item: KnowledgeBaseRecord) => {
    if (
      !window.confirm(
        "删除知识库「" +
          item.name +
          "」？文档和本地来源都不会保留在应用配置中，本地文件不会被删除。",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.deleteKnowledgeBase(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      if (selectedId === item.id) setSelectedId(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  /** 刀 4：导入知识库分享包（弹打开对话框 → 建新库 → 选中新库 + 刷新列表） */
  const importSharePackage = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await window.electronAPI.importKnowledgeBaseShare();
      if (!created) return; // 用户取消
      setItems((current) => [created, ...current]);
      setSelectedId(created.id);
      toast.success(`已导入知识库「${created.name}」`);
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }, []);

  if (selected) {
    return (
      <KnowledgeBaseDetail
        key={selected.id}
        item={selected}
        initialDocumentId={requestedDocumentId}
        navigationRequestId={navigation?.requestId}
        busy={busy}
        error={error}
        onBack={() => {
          setSelectedId(null);
          setRequestedDocumentId(undefined);
          void reload();
        }}
        onError={setError}
        onAddSource={() => void addSource(selected.id)}
        onRemoveSource={(sourceId) => void removeSource(selected.id, sourceId)}
        onDelete={() => void remove(selected)}
        onImportShare={() => void importSharePackage()}
      />
    );
  }

  return (
    <main className="kl-page scrollbar-thin" aria-label="个人知识">
      <header className="kl-header">
        <div>
          <h2>知识</h2>
          <p>把整理过的记录留下来，成为随时能查阅的个人积累。</p>
        </div>
        <div className="kl-actions">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void importSharePackage()}
            disabled={loading || busy}
          >
            <DownloadSimple />
            导入分享包
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => void reload()}
            disabled={loading || busy}
            aria-label="刷新知识库"
          >
            <ArrowClockwise className={cn(loading && "animate-spin")} />
          </Button>
          <Button size="sm" onClick={() => setDialogOpen(true)} disabled={busy}>
            <Plus />
            新建知识库
          </Button>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      <KnowledgeLibrary
        bases={items}
        documents={libraryDocuments}
        loading={loading || documentCountLoading}
        onCreate={() => setDialogOpen(true)}
        onBase={(id) => {
          setSelectedId(id);
          setRequestedDocumentId(undefined);
        }}
        onDocument={(document) => {
          setSelectedId(document.knowledgeBaseId);
          setRequestedDocumentId(document.id);
        }}
      />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>新建知识库</DialogTitle>
          <DialogDescription>
            知识库不绑定项目。创建后可以直接新建文档，也可以添加外部目录作为检索来源。
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">名称</span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：产品设计规范"
                className="w-full"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">描述（可选）</span>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="这套知识主要用于什么场景？"
                className="w-full resize-none"
              />
            </label>
            <div className="rounded-xl border bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">外部目录（可选）</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅作为来源，不会复制或删除本地文件。
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void choosePaths()}
                >
                  <FolderOpen size={15} />
                  选择目录
                </Button>
              </div>
              {paths.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {paths.map((path) => (
                    <li
                      key={path}
                      className="flex gap-2 text-xs text-muted-foreground"
                    >
                      <CheckCircle
                        size={14}
                        className="text-emerald-600"
                        weight="fill"
                      />
                      <span className="truncate" title={path}>
                        {path}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setDialogOpen(false)}
                disabled={busy}
              >
                取消
              </Button>
              <Button
                onClick={() => void create()}
                disabled={busy || !name.trim()}
              >
                {busy ? "创建中…" : "创建知识库"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ErrorBanner({ message }: { message: string }): JSX.Element {
  return (
    <div
      className="mb-5 flex gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      role="alert"
    >
      <WarningCircle size={18} />
      <span>{message}</span>
    </div>
  );
}

/** 文档类型小标签：按 kind 显示「笔记 / 接口约定 / 规范 / 常识快照」；无 kind 归一为笔记 */
function KindBadge({
  kind,
  className,
}: {
  kind: KnowledgeBaseDocument["kind"];
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border/50 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {kindLabel(kind)}
    </span>
  );
}

function KnowledgeBaseDetail({
  item,
  initialDocumentId,
  navigationRequestId,
  busy,
  error,
  onBack,
  onError,
  onAddSource,
  onRemoveSource,
  onDelete,
  onImportShare,
}: {
  item: KnowledgeBaseRecord;
  initialDocumentId?: string;
  navigationRequestId?: number;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onError: (message: string | null) => void;
  onAddSource: () => void;
  onRemoveSource: (sourceId: string) => void;
  onDelete: () => void;
  /** 刀 4：导入分享包（建新库并跳转；由父组件驱动选中新库） */
  onImportShare: () => void;
}): JSX.Element {
  const [documents, setDocuments] = useState<KnowledgeBaseDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorTags, setEditorTags] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);
  const [urlDialogOpen, setUrlDialogOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteTitle, setRemoteTitle] = useState("");
  const [browserImportOpened, setBrowserImportOpened] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const browserImportSessionId = "knowledge-base-import-" + item.id;
  /**
   * 跨库打开文档时的 pending：来源芯片点击 → App 派发 DOCUMENT_SELECT_EVENT，
   * 但此时文档列表可能仍在加载（loadDocuments 会 setActiveId(null)）。
   * 列表未就绪时暂存 documentId，加载完成后若文档存在则补选。
   */
  const pendingDocumentIdRef = useRef<string | null>(initialDocumentId ?? null);
  // 事件监听 closure 需要「最新」loading：切库时 listener effect 重注册那一刻
  // loading 尚未翻 true，直接读 state 会读到陈旧 false 而误判已加载、被 loadDocuments 的
  // setActiveId(null) 冲掉选中。用 ref 在 render 期同步，handler 永远读最新值。
  const loadingRef = useRef(true);
  loadingRef.current = loading;

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.electronAPI.listKnowledgeBaseDocuments({
        knowledgeBaseId: item.id,
      });
      setDocuments(next);
      // 优先消费 pending 文档选中（来自引用芯片跨库打开）；否则清空选中。
      const pending = pendingDocumentIdRef.current;
      pendingDocumentIdRef.current = null;
      if (pending && next.some((doc) => doc.id === pending)) {
        setActiveId(pending);
        setMode("preview");
      } else if (pending) {
        setActiveId(null);
        onError("找不到这篇知识文档，可能已被删除。");
      } else {
        setActiveId(next[0]?.id ?? null);
        setMode("preview");
      }
    } catch (e) {
      onError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [item.id, onError]);
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);
  useEffect(() => {
    setActiveId(null);
    setMode("preview");
  }, [item.id]);
  const active = documents.find((doc) => doc.id === activeId) ?? null;
  const isDirty = Boolean(
    active &&
    (editorTitle !== active.title ||
      editorContent !== active.content ||
      JSON.stringify(parseWorkbenchTags(editorTags)) !==
        JSON.stringify(active.tags ?? [])),
  );
  const confirmDiscard = () =>
    !isDirty || window.confirm("当前文档有未保存修改，确定放弃吗？");
  const selectDocument = (id: string) => {
    if (id === activeId || !confirmDiscard()) return;
    setActiveId(id);
    setMode("preview");
  };
  useEffect(() => {
    setEditorTitle(active?.title ?? "");
    setEditorTags((active?.tags ?? []).join(" "));
    setEditorContent(active?.content ?? "");
  }, [activeId, active?.content, active?.title, active?.tags]);

  useEffect(() => {
    if (!initialDocumentId) return;
    if (loadingRef.current) {
      pendingDocumentIdRef.current = initialDocumentId;
      return;
    }
    const destination = documents.find((doc) => doc.id === initialDocumentId);
    if (destination) {
      setActiveId(destination.id);
      setEditorTitle(destination.title);
      setEditorTags((destination.tags ?? []).join(" "));
      setEditorContent(destination.content);
      setMode("preview");
    } else onError("找不到这篇知识文档，可能已被删除。");
  }, [initialDocumentId, navigationRequestId]);
  useEffect(() => {
    const leave = (event: Event) => {
      if (saving || !confirmDiscard()) event.preventDefault();
    };
    window.addEventListener(KNOWLEDGE_LEAVE_EVENT, leave);
    return () => window.removeEventListener(KNOWLEDGE_LEAVE_EVENT, leave);
  }, [isDirty, saving]);
  const filteredDocuments = documents
    .filter(
      (doc) =>
        workbenchHasTag(doc.tags, tag) &&
        (doc.title + "\n" + doc.content + "\n" + (doc.tags ?? []).join(" "))
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const documentTags = knowledgeTopicCounts(documents)
    .map(([value]) => value)
    .sort((a, b) => a.localeCompare(b));
  const newDocument = async (kind: KnowledgeBaseDocumentKind = "note") => {
    if (!confirmDiscard()) return;
    setSaving(true);
    onError(null);
    try {
      const tpl = templateForKind(kind);
      const created = await window.electronAPI.createKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
        title: tpl.title,
        content: tpl.content,
        kind,
      });
      setDocuments((current) => [created, ...current]);
      setActiveId(created.id);
      setMode("edit");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const importDocument = async () => {
    if (!confirmDiscard()) return;
    setSaving(true);
    onError(null);
    try {
      const imported = await window.electronAPI.importKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
      });
      if (!imported) return;
      const importedDocuments = Array.isArray(imported) ? imported : [imported];
      const firstImported = importedDocuments[0];
      if (!firstImported) return;
      setDocuments((current) => [...importedDocuments, ...current]);
      setActiveId(firstImported.id);
      setMode("preview");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const openRemoteInBrowser = async () => {
    const url = extractHttpUrl(remoteUrl);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      onError("没有找到完整的 http(s) 云文档地址");
      return;
    }
    onError(null);
    try {
      await browserApi().browserOpenWindow({
        sessionId: browserImportSessionId,
        url,
        title: "云文档导入",
      });
      await browserApi().browserPrepareDownload(browserImportSessionId);
      setRemoteUrl(url);
      setBrowserImportOpened(true);
    } catch (e) {
      onError(errorText(e));
    }
  };

  const importBrowserFile = async () => {
    if (!confirmDiscard()) return;
    setSaving(true);
    onError(null);
    try {
      const imported =
        await window.electronAPI.importKnowledgeBaseDocumentDownload({
          knowledgeBaseId: item.id,
          sessionId: browserImportSessionId,
          title: remoteTitle.trim() || undefined,
        });
      const importedDocuments = Array.isArray(imported) ? imported : [imported];
      const firstImported = importedDocuments[0];
      if (!firstImported) return;
      setDocuments((current) => [...importedDocuments, ...current]);
      setActiveId(firstImported.id);
      setMode("preview");
      setUrlDialogOpen(false);
      setRemoteUrl("");
      setRemoteTitle("");
      setBrowserImportOpened(false);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const importBrowserPage = async () => {
    if (!confirmDiscard()) return;
    setSaving(true);
    onError(null);
    try {
      const page = await browserApi().browserExtractWindowText(
        browserImportSessionId,
      );
      const content = page.text.trim();
      if (content.length < 40) {
        throw new Error(
          "当前网页正文太短，请先在内置浏览器中完成登录并打开文档正文",
        );
      }
      const imported = await window.electronAPI.createKnowledgeBaseDocument({
        knowledgeBaseId: item.id,
        title: remoteTitle.trim() || page.title || "网页文档",
        content,
        sourceUrl: page.url,
        sourceProvider: "unknown",
        sourceAccessMode: "browser",
        sourceSyncedAt: Date.now(),
      });
      setDocuments((current) => [imported, ...current]);
      setActiveId(imported.id);
      setMode("preview");
      setUrlDialogOpen(false);
      setRemoteUrl("");
      setRemoteTitle("");
      setBrowserImportOpened(false);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleDocumentSelect = (event: Event): void => {
      const documentId = (event as CustomEvent<{ documentId?: string }>).detail
        ?.documentId;
      if (!documentId) return;
      // 列表仍在加载：暂存 pending，loadDocuments 完成后补选（避免被 setActiveId(null) 冲掉）。
      if (loadingRef.current) {
        pendingDocumentIdRef.current = documentId;
        return;
      }
      selectDocument(documentId);
    };
    const handleBaseBack = (): void => {
      if (confirmDiscard()) onBack();
    };
    const handleNewDocument = (event: Event): void => {
      const kind = (event as CustomEvent<{ kind?: KnowledgeBaseDocumentKind }>)
        .detail?.kind;
      void newDocument(kind ?? "note");
    };
    const handleRemoveSource = (event: Event): void => {
      const sourceId = (event as CustomEvent<{ sourceId?: string }>).detail
        ?.sourceId;
      if (sourceId) onRemoveSource(sourceId);
    };
    window.addEventListener(BASE_BACK_EVENT, handleBaseBack);
    window.addEventListener(DOCUMENT_SELECT_EVENT, handleDocumentSelect);
    window.addEventListener(NEW_DOCUMENT_EVENT, handleNewDocument);
    window.addEventListener(REMOVE_SOURCE_EVENT, handleRemoveSource);
    return () => {
      window.removeEventListener(BASE_BACK_EVENT, handleBaseBack);
      window.removeEventListener(DOCUMENT_SELECT_EVENT, handleDocumentSelect);
      window.removeEventListener(NEW_DOCUMENT_EVENT, handleNewDocument);
      window.removeEventListener(REMOVE_SOURCE_EVENT, handleRemoveSource);
    };
  }, [activeId, isDirty, item.id, onBack, onRemoveSource]);

  const save = async () => {
    if (!active) return;
    setSaving(true);
    onError(null);
    try {
      const updated = await window.electronAPI.updateKnowledgeBaseDocument({
        id: active.id,
        title: editorTitle,
        tags: parseWorkbenchTags(editorTags),
        content: editorContent,
      });
      setDocuments((current) =>
        current.map((doc) => (doc.id === updated.id ? updated : doc)),
      );
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!active || !window.confirm("删除文档「" + active.title + "」？"))
      return;
    setSaving(true);
    onError(null);
    try {
      await window.electronAPI.deleteKnowledgeBaseDocument(active.id);
      setDocuments((current) => current.filter((doc) => doc.id !== active.id));
      setActiveId(null);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  /** 刀 4：导出当前知识库为分享包（主进程弹保存对话框写 .tagent-kb.json） */
  const exportSharePackage = async () => {
    setExporting(true);
    try {
      const res = await window.electronAPI.exportKnowledgeBase({ id: item.id });
      if (res.ok) {
        toast.success(res.path ? `已导出到 ${res.path}` : "已导出分享包");
      } else if (res.reason !== "canceled") {
        const msg = res.error || res.reason || "导出失败";
        toast.error(msg);
        onError(msg);
      }
    } catch (e) {
      const msg = errorText(e);
      toast.error(msg);
      onError(msg);
    } finally {
      setExporting(false);
    }
  };

  return (
    <main className="kl-page kl-detail scrollbar-thin" aria-label="知识库文档">
      <header className="kl-header">
        <div className="kl-base-heading">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirmDiscard()) onBack();
            }}
            disabled={saving}
          >
            <ArrowLeft />
            全部知识
          </Button>
          <div>
            <h2>{item.name}</h2>
            <p>{item.description || "在这里阅读、整理与复用知识"}</p>
          </div>
        </div>
        <div className="kl-actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={busy || saving}>
                <Plus />
                添加内容
                <CaretDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {KIND_CREATE_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option.kind}
                  onSelect={() => void newDocument(option.kind)}
                >
                  <FileText size={16} />
                  {option.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void importDocument()}>
                <FileArrowUp size={16} />
                导入本地文件
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setUrlDialogOpen(true)}>
                <LinkSimple size={16} />
                导入云文档
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onAddSource}>
                <FolderOpen size={16} />
                添加目录来源
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="更多知识库操作"
                disabled={busy || saving || exporting}
              >
                <DotsThreeVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void exportSharePackage()}>
                <Share size={16} />
                导出分享包
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  if (confirmDiscard()) onImportShare();
                }}
              >
                <DownloadSimple size={16} />
                导入分享包
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  if (confirmDiscard()) onDelete();
                }}
                className="text-destructive"
              >
                <Trash size={16} />
                删除知识库
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      <div className="kl-detail-layout">
        <aside className="kl-document-browser" aria-label="知识库文档列表">
          <div className="kl-catalog-heading">
            <h3>
              文档 <span>{documents.length}</span>
            </h3>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="新建知识文档"
              disabled={saving || busy}
              onClick={() => void newDocument()}
            >
              <Plus />
            </Button>
          </div>
          <label className="kl-search">
            <MagnifyingGlass aria-hidden="true" size={16} />
            <Input
              type="search"
              aria-label="搜索库内文档"
              placeholder="查找文档或正文"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {!!documentTags.length && (
            <WorkbenchSelect
              label="知识文档标签筛选"
              value={tag}
              onValueChange={setTag}
              options={[
                { value: "", label: "全部标签" },
                ...documentTags.map((value) => ({ value, label: "#" + value })),
              ]}
            />
          )}
          {loading ? (
            <p role="status" className="kl-description">
              正在加载文档…
            </p>
          ) : (
            <ul className="kl-document-list">
              {filteredDocuments.map((document) => (
                <li key={document.id}>
                  <button
                    type="button"
                    className="kl-document-row"
                    aria-pressed={document.id === activeId}
                    aria-label={"阅读：" + document.title}
                    onClick={() => selectDocument(document.id)}
                    disabled={saving}
                  >
                    <span className="kl-card-meta">
                      <span>
                        <FileText size={14} />
                        {kindLabel(document.kind)}
                      </span>
                      <time>{knowledgeDate(document.updatedAt)}</time>
                    </span>
                    <strong>{document.title}</strong>
                    <p>{documentExcerpt(document.content) || "空文档"}</p>
                    {!!document.tags?.length && (
                      <span className="kl-row-tags">
                        {document.tags
                          .slice(0, 2)
                          .map((value) => "#" + value)
                          .join(" · ")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && !filteredDocuments.length && (
            <p className="kl-description">
              {documents.length
                ? "没有匹配的文档，请调整筛选。"
                : "点击上方 + 新建第一篇文档。"}
            </p>
          )}
          <details className="kl-directory-sources">
            <summary>目录来源 · {item.sources.length}</summary>
            <p className="kl-description">
              目录作为检索来源，原文件保留在本地。
            </p>
            {item.sources.map((source) => (
              <div key={source.id}>
                <FolderOpen size={15} />
                <span title={source.path}>{source.path}</span>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={"移除目录来源：" + source.path}
                  disabled={busy || saving}
                  onClick={() => onRemoveSource(source.id)}
                >
                  <X size={14} />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || saving}
              onClick={onAddSource}
            >
              <Plus />
              添加目录
            </Button>
          </details>
        </aside>
        <section className="kl-reading-pane" aria-label="知识文档阅读与编辑">
          {active ? (
            <>
              <div className="kl-reader-toolbar">
                <span className="kl-reading-status">
                  <KindBadge kind={active.kind} />
                  <span role="status">
                    {saving ? "正在保存…" : isDirty ? "有未保存修改" : "已保存"}
                  </span>
                </span>
                <div className="kl-actions">
                  {mode === "edit" ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={saving}
                        onClick={() => {
                          setEditorTitle(active.title);
                          setEditorTags((active.tags ?? []).join(" "));
                          setEditorContent(active.content);
                          setMode("preview");
                        }}
                      >
                        取消编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={saving}
                        onClick={() => setMode("preview")}
                      >
                        预览
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => setMode("edit")}
                    >
                      <PencilSimple />
                      编辑
                    </Button>
                  )}
                  {(mode === "edit" || isDirty) && (
                    <Button
                      size="sm"
                      onClick={() => void save()}
                      disabled={saving || !editorTitle.trim() || !isDirty}
                    >
                      保存修改
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="删除文档"
                    disabled={saving}
                    onClick={() => void remove()}
                  >
                    <Trash />
                  </Button>
                </div>
              </div>
              <article className="kl-reader">
                {mode === "edit" ? (
                  <>
                    <label className="kl-field">
                      文档标题
                      <Input
                        value={editorTitle}
                        aria-label="文档标题"
                        onChange={(event) => setEditorTitle(event.target.value)}
                        placeholder="给知识起一个清晰的名字"
                      />
                    </label>
                    <label className="kl-field">
                      主题标签
                      <Input
                        value={editorTags}
                        aria-label="知识文档标签"
                        onChange={(event) => setEditorTags(event.target.value)}
                        placeholder="#主题/子主题 #项目"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <h3>{editorTitle}</h3>
                    <div className="kl-reader-meta">
                      <time>
                        更新于{" "}
                        {new Date(active.updatedAt).toLocaleString("zh-CN")}
                      </time>
                      {active.tags?.map((value) => (
                        <Button
                          key={value}
                          variant="outline"
                          size="sm"
                          className="kl-tag"
                          onClick={() => setTag(value)}
                        >
                          #{value}
                        </Button>
                      ))}
                    </div>
                  </>
                )}
                {(active.sourceUrl || active.originNote) && (
                  <div className="kl-origin">
                    <span>内容来源</span>
                    {active.originNote && <p>{active.originNote}</p>}
                    {active.sourceUrl && (
                      <a
                        href={active.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {active.sourceUrl}
                        <ArrowRight size={14} />
                      </a>
                    )}
                    {active.sourceProvider && (
                      <p>
                        {sourceProviderLabel(active.sourceProvider)}
                        {active.sourceSyncedAt
                          ? " · 快照于 " +
                            new Date(active.sourceSyncedAt).toLocaleString(
                              "zh-CN",
                            )
                          : ""}
                      </p>
                    )}
                  </div>
                )}
                {mode === "edit" ? (
                  <label className="kl-field">
                    正文 · Markdown
                    <Textarea
                      className="kl-editor"
                      value={editorContent}
                      onChange={(event) => setEditorContent(event.target.value)}
                      aria-label="文档内容"
                      placeholder="在这里写下确认过的知识…"
                    />
                  </label>
                ) : editorContent ? (
                  <MessageResponse className="kl-reader-prose">
                    {editorContent}
                  </MessageResponse>
                ) : (
                  <p className="kl-description">
                    还没有正文，点击“编辑”开始记录。
                  </p>
                )}
              </article>
            </>
          ) : (
            <div className="kl-empty">
              <Books size={32} />
              <h3>{loading ? "正在读取知识…" : "从一篇文档开始积累"}</h3>
              <p>选择左侧文档开始阅读，或新建、导入已有资料。</p>
              {!loading && (
                <Button
                  onClick={() => void newDocument()}
                  disabled={saving || busy}
                >
                  <Plus />
                  新建文档
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
      <Dialog open={urlDialogOpen} onOpenChange={setUrlDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>导入云文档</DialogTitle>
          <DialogDescription>
            在独立的 TAgent
            浏览器窗口中打开文档。你可以在完整窗口中登录、扫码并打开正文。
          </DialogDescription>
          <div className="mt-5 space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">文档地址</span>
              <Input
                autoFocus
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(extractHttpUrl(e.target.value))}
                placeholder="可粘贴标题 + Markdown 链接"
                className="w-full"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block font-medium">标题（可选）</span>
              <Input
                value={remoteTitle}
                onChange={(e) => setRemoteTitle(e.target.value)}
                placeholder="不填则使用下载文件名或网页标题"
                className="w-full"
              />
            </label>
            {browserImportOpened && (
              <p className="rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary">
                已在独立浏览器窗口打开。请在网页中完成登录并点击下载，下载完成后回到这里导入原始文件；也可直接读取网页正文。
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setUrlDialogOpen(false)}
                disabled={saving}
              >
                关闭
              </Button>
              <Button
                variant="outline"
                onClick={() => void openRemoteInBrowser()}
                disabled={saving || !remoteUrl.trim()}
              >
                打开独立浏览器
              </Button>
              <Button
                variant="outline"
                onClick={() => void importBrowserPage()}
                disabled={saving || !browserImportOpened}
              >
                {saving ? "读取中…" : "读取网页正文"}
              </Button>
              <Button
                onClick={() => void importBrowserFile()}
                disabled={saving || !browserImportOpened}
              >
                {saving ? "导入中…" : "下载并导入原始文件"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
