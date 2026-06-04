import * as React from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function MultiSelect({
  label,
  options,
  value,
  onChange,
  placeholder = "全部",
  className,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const allChecked = options.length > 0 && value.length === options.length;
  const toggle = (opt: string) => {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  };
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-8 justify-between font-normal min-w-[140px]"
          >
            <span className="truncate text-left">
              {value.length === 0 ? (
                <span className="text-muted-foreground">{placeholder}</span>
              ) : value.length <= 2 ? (
                value.join("、")
              ) : (
                `已选 ${value.length} 项`
              )}
            </span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60 ml-2 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-2 w-56" align="start">
          <div className="flex items-center justify-between px-2 py-1 text-xs">
            <button
              className="text-primary hover:underline"
              onClick={() => onChange(allChecked ? [] : [...options])}
            >
              {allChecked ? "清空" : "全选"}
            </button>
            {value.length > 0 && (
              <button
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                onClick={() => onChange([])}
              >
                <X className="h-3 w-3" /> 清空
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-auto mt-1">
            {options.length === 0 ? (
              <div className="px-2 py-3 text-xs text-muted-foreground text-center">无选项</div>
            ) : (
              options.map((opt) => (
                <label
                  key={opt}
                  className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-sm"
                >
                  <Checkbox
                    checked={value.includes(opt)}
                    onCheckedChange={() => toggle(opt)}
                  />
                  <span className="truncate">{opt}</span>
                </label>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
