"use client";

import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/** Switch the location being edited (the tab resets to Favourites). */
export function LocationPicker({
  locations,
  current,
  label,
}: {
  locations: { id: string; name: string }[];
  current: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-2 sm:w-64">
      <Label htmlFor="quick-keys-location">{label}</Label>
      <NativeSelect
        id="quick-keys-location"
        value={current}
        onChange={(event) =>
          router.push(`/catalog/quick-keys?location=${encodeURIComponent(event.target.value)}`)
        }
      >
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
