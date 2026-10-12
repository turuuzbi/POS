"use client";

import { Lock, LogOut, UserRound, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Role } from "@/domain/permissions";
import { useAction } from "@/hooks/use-action";
import { logout } from "@/server/actions/auth";

export function UserMenu({
  name,
  role,
  onDevice,
}: {
  name: string;
  role: Role;
  onDevice: boolean;
}) {
  const t = useTranslations();
  const { run, pending } = useAction(logout);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label={name}>
          <UserRound className="size-5" aria-hidden />
          <span className="hidden max-w-[10rem] truncate sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate">{name}</span>
          <span className="text-xs font-normal text-muted-foreground">{t(`roles.${role}`)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onDevice ? (
          <DropdownMenuItem disabled={pending} onSelect={() => run({}, { toastOnError: true })}>
            <Users aria-hidden />
            {t("auth.switchUser")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          variant="destructive"
          disabled={pending}
          onSelect={() => run({}, { toastOnError: true })}
        >
          {onDevice ? <Lock aria-hidden /> : <LogOut aria-hidden />}
          {onDevice ? t("auth.lock") : t("auth.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
