import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";

// TipTap off the shelf, as the plan requires. The editor is the single
// largest piece of application work available to sink time into, and none of
// it would teach anything about running the system.
export function Editor({
  doc,
  provider,
  name,
}: {
  doc: Y.Doc;
  provider: WebsocketProvider;
  name: string;
}) {
  const editor = useEditor(
    {
      extensions: [
        // History is disabled because Collaboration brings its own, backed by
        // the CRDT. Leaving both on gives two undo stacks that disagree.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: doc, field: "body" }),
        CollaborationCursor.configure({
          provider,
          user: { name, color: (provider.awareness.getLocalState()?.user as any)?.color ?? "#0B6B5C" },
        }),
      ],
      editorProps: {
        attributes: { class: "prose", spellcheck: "false" },
      },
    },
    [doc, provider],
  );

  return <EditorContent editor={editor} className="editor" />;
}
