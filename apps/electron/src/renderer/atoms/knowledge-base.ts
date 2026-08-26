import { atom } from "jotai";
import type {
  KnowledgeBaseDocument,
  KnowledgeBaseRecord,
} from "@tagent/shared";

export type KnowledgeBaseSidebarState =
  | {
      mode: "bases";
      items: KnowledgeBaseRecord[];
      selectedId: string | null;
      loading: boolean;
    }
  | {
      mode: "documents";
      knowledgeBaseId: string;
      knowledgeBaseName: string;
      documents: KnowledgeBaseDocument[];
      activeId: string | null;
      sources: KnowledgeBaseRecord["sources"];
      loading: boolean;
    };

export const knowledgeBaseSidebarAtom = atom<KnowledgeBaseSidebarState>({
  mode: "bases",
  items: [],
  selectedId: null,
  loading: true,
});
