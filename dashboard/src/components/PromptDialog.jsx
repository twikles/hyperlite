import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePromptStore } from "../store/usePromptStore";

// Name / value prompt in the same accessible dialog system as every other dialog: labelled field, Enter
// submits, Escape cancels, empty values are refused with a message instead of being silently ignored.
export default function PromptDialog({ cancelLabel = "Cancel" }) {
  const request = usePromptStore((s) => s.request);
  const answer = usePromptStore((s) => s.answer);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => { setValue(request?.defaultValue ?? ""); setTouched(false); }, [request]);

  const trimmed = value.trim();
  const invalid = trimmed === "" ? "This value is required." : request?.validate?.(trimmed) || "";
  const submit = () => { setTouched(true); if (!invalid) answer(trimmed); };

  return (
    <Dialog open={!!request} onOpenChange={(o) => { if (!o) answer(null); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request?.message && <DialogDescription>{request.message}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-2">
          <Label htmlFor="prompt-value" className="text-xs font-medium">{request?.label}</Label>
          <Input id="prompt-value" aria-label={request?.label} autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={touched && !!invalid} aria-describedby={touched && invalid ? "prompt-error" : undefined} />
          {touched && invalid && <p id="prompt-error" role="alert" className="text-xs text-status-error">{invalid}</p>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="secondary" onClick={() => answer(null)}>{cancelLabel}</Button>
            <Button type="submit">{request?.confirmLabel || "OK"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
