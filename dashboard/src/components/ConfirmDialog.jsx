import { useRef } from "react";
import { AlertTriangle } from "lucide-react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Radix's AlertDialog provides the focus trap / Escape-to-cancel behavior, but its
// own focus-restore-on-close only works when Radix's own <AlertDialogTrigger>
// opened it. Every caller here opens it by flipping an externally-owned `open`
// prop instead (a button somewhere else in a list, a delete icon, ...), so Radix
// never learns which element to return focus to and Escape/close leaves focus
// nowhere. onOpenAutoFocus fires right as Radix's own FocusScope mounts, before
// it moves focus into the dialog, so document.activeElement there is still
// whatever was focused just before (the button that was clicked) -- captured in
// an event callback, not during render.
export default function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true, onConfirm, onCancel }) {
  const triggerRef = useRef(null);

  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent
        className="max-w-sm"
        onOpenAutoFocus={() => { triggerRef.current = document.activeElement; }}
        onCloseAutoFocus={(e) => {
          if (triggerRef.current instanceof HTMLElement && document.body.contains(triggerRef.current)) {
            e.preventDefault();
            triggerRef.current.focus();
          }
        }}
      >
        <AlertDialogHeader className="flex-row items-start gap-3 space-y-0">
          <div className={`mt-0.5 rounded-full p-1.5 ${danger ? "bg-status-error/15 text-status-error" : "bg-accent-blue/15 text-accent-blue"}`}>
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1 text-left">
            <AlertDialogTitle className="text-sm">{title}</AlertDialogTitle>
            <AlertDialogDescription className="mt-1 text-sm">{message}</AlertDialogDescription>
          </div>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={danger ? cn(buttonVariants({ variant: "destructive" }), "bg-status-error/10 text-status-error border border-status-error/30 hover:bg-status-error/20") : undefined}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
