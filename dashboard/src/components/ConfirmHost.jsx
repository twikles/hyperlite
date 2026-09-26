import { useConfirmStore } from "../store/useConfirmStore";
import ConfirmDialog from "./ConfirmDialog";
import PromptDialog from "./PromptDialog";

// The labels default to English for the historical interface; the rebuilt one passes its translations.
export default function ConfirmHost({ confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
  const request = useConfirmStore((s) => s.request);
  const answer = useConfirmStore((s) => s.answer);
  return (
    <>
    <PromptDialog cancelLabel={cancelLabel} />
    <ConfirmDialog
      open={!!request}
      title={request?.title ?? ""}
      message={request?.message ?? ""}
      confirmLabel={request?.confirmLabel ?? confirmLabel}
      cancelLabel={cancelLabel}
      danger={request?.danger ?? true}
      onConfirm={() => answer(true)}
      onCancel={() => answer(false)}
    />
    </>
  );
}
