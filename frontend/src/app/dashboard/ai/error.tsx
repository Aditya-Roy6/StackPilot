"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { AppIcon } from "@/lib/custom-icons";

import { Button } from "@/components/ui/button";

// This Next version passes `unstable_retry`, not `reset` — destructuring `reset`
// yields undefined and the retry button throws on click.
export default function AiAgentError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[32rem] items-center justify-center rounded-xl border border-border bg-card p-6 text-card-foreground">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-background">
          <AppIcon name="alert-triangle" fallback={AlertTriangle} className="h-6 w-6 text-destructive"  />
        </div>
        <h2 className="text-xl font-semibold">AI Agent could not load</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || "The playground hit a client-side error. Reload the page or go back to the dashboard."}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button type="button" variant="outline" onClick={() => history.back()}>
            <AppIcon name="arrow-left" fallback={ArrowLeft} className="h-4 w-4"  />
            Back
          </Button>
          <Button type="button" onClick={() => unstable_retry()}>
            <AppIcon name="rotate-ccw" fallback={RotateCcw} className="h-4 w-4"  />
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
