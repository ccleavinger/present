import { Show, createSignal, onMount } from "solid-js";
import { DeckList } from "./components/DeckList";
import { Editor } from "./components/Editor";

type Route = { view: "list" } | { view: "editor"; id: string };

function parseRoute(): Route {
  const match = window.location.hash.match(/^#\/deck\/([^/]+)$/);
  return match ? { view: "editor", id: decodeURIComponent(match[1]) } : { view: "list" };
}

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute());

  onMount(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

  const open = (id: string) => {
    window.location.hash = `#/deck/${encodeURIComponent(id)}`;
  };
  const back = () => {
    window.location.hash = "#/";
  };

  return (
    <Show
      when={route().view === "editor"}
      fallback={<DeckList onOpen={open} />}
    >
      {(() => {
        const current = route();
        return current.view === "editor" ? (
          <Editor deckId={current.id} onBack={back} />
        ) : null;
      })()}
    </Show>
  );
}
