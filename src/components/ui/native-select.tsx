import { ChevronDown } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Styled native <select>: best accessibility and the platform picker on
 * tablets/phones (large, familiar, keyboard-friendly).
 */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        data-slot="native-select"
        className={cn(
          "flex h-11 w-full appearance-none rounded-md border border-input bg-transparent py-1 pr-10 pl-3 text-base shadow-xs outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "aria-invalid:border-destructive",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export { NativeSelect };
