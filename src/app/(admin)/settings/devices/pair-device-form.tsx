"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAction } from "@/hooks/use-action";
import { pairThisDevice } from "@/server/actions/devices";

interface LocationOption {
  id: string;
  name: string;
  registers: { id: string; name: string; code: string }[];
}

export function PairDeviceForm({ locations }: { locations: LocationOption[] }) {
  const t = useTranslations("devices");
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors } = useAction(pairThisDevice);
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "");
  const registers = locations.find((l) => l.id === locationId)?.registers ?? [];
  const [registerId, setRegisterId] = useState(registers[0]?.id ?? "");

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        run(
          { name, locationId, registerId: registerId || null },
          {
            onSuccess: () => {
              toast.success(t("paired"));
              setName("");
              nameRef.current?.focus(); // the submit button just became disabled
              router.refresh();
            },
          },
        );
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="device-name">{t("name")}</Label>
        <Input
          id="device-name"
          ref={nameRef}
          value={name}
          maxLength={80}
          placeholder={t("namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={fieldErrors.name ? true : undefined}
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="device-location">{t("location")}</Label>
          <NativeSelect
            id="device-location"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              const first = locations.find((l) => l.id === e.target.value)?.registers[0];
              setRegisterId(first?.id ?? "");
            }}
          >
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="device-register">{t("register")}</Label>
          <NativeSelect
            id="device-register"
            value={registerId}
            onChange={(e) => setRegisterId(e.target.value)}
          >
            <option value="">{t("noRegister")}</option>
            {registers.map((register) => (
              <option key={register.id} value={register.id}>
                {register.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {errorMessage ? (
        <p id="pair-device-error" role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <Button
        type="submit"
        // aria-disabled while pending keeps keyboard focus on the button.
        disabled={!pending && (!name.trim() || !locationId)}
        aria-disabled={pending || undefined}
        aria-describedby={errorMessage ? "pair-device-error" : undefined}
      >
        {pending ? t("pairing") : t("pair")}
      </Button>
    </form>
  );
}
