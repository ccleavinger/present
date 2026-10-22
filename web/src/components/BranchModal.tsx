import { createSignal } from "solid-js";
import { Modal } from "./Modal";

interface BranchModalProps {
  currentBranch: string;
  onClose: () => void;
  onCreate: (name: string, checkout: boolean) => Promise<void>;
}

export function BranchModal(props: BranchModalProps) {
  const [name, setName] = createSignal("");
  const [checkout, setCheckout] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const value = name().trim();
    if (!value) {
      setError("Branch name is required.");
      return;
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..")) {
      setError("Use letters, numbers, '.', '_', '-' or '/'.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onCreate(value, checkout());
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New branch"
      subtitle={`Branch from ${props.currentBranch}. The current session is committed first.`}
      onClose={props.onClose}
      footer={
        <>
          <span class="muted small">A branch switch also creates a session commit.</span>
          <div class="row-gap">
            <button class="btn ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button class="btn accent" form="branch-form" type="submit" disabled={busy()}>
              {busy() ? "Creating…" : "Create branch"}
            </button>
          </div>
        </>
      }
    >
      <form id="branch-form" onSubmit={submit}>
        <label class="field">
          <span>Branch name</span>
          <input
            autofocus
            type="text"
            placeholder="feature/new-title"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={checkout()}
            onChange={(event) => setCheckout(event.currentTarget.checked)}
          />
          Check out the new branch
        </label>
        {error() && <div class="alert error">{error()}</div>}
      </form>
    </Modal>
  );
}
