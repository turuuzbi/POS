import { MonitorCheck, MonitorSmartphone } from "lucide-react";
import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePermission } from "@/server/auth/session";
import { currentDevice, listDevices, listPairableLocations } from "@/server/queries/devices";
import { PairDeviceForm } from "./pair-device-form";
import { DEVICE_LIST_HEADING_ID, RevokeDeviceButton } from "./revoke-device-button";
import { UnlockPinButton } from "./unlock-pin-button";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("devices");
  return { title: t("title") };
}

export default async function DevicesPage() {
  const user = await requirePermission("devices.manage");
  const [t, format, locations, devices, thisDevice] = await Promise.all([
    getTranslations("devices"),
    getFormatter(),
    listPairableLocations(user),
    listDevices(user),
    currentDevice(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MonitorCheck className="size-5" aria-hidden />
              {t("thisDevice")}
            </CardTitle>
            <CardDescription>
              {thisDevice
                ? t("thisDevicePaired", {
                    name: thisDevice.name,
                    location: thisDevice.locationName,
                  })
                : t("thisDeviceNotPaired")}
            </CardDescription>
          </CardHeader>
          {thisDevice ? (
            <CardContent>
              <RevokeDeviceButton
                deviceId={thisDevice.id}
                label={t("unpair")}
                confirm={t("unpairConfirm")}
                successMessage={t("unpaired")}
              />
            </CardContent>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("pairTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <PairDeviceForm locations={locations} />
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby={DEVICE_LIST_HEADING_ID} className="space-y-3">
        <h2
          id={DEVICE_LIST_HEADING_ID}
          tabIndex={-1}
          className="text-lg font-semibold focus-visible:outline-none"
        >
          {t("listTitle")}
        </h2>
        {devices.length === 0 ? (
          <EmptyState icon={MonitorSmartphone} title={t("empty")} />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.location")}</TableHead>
                  <TableHead>{t("columns.register")}</TableHead>
                  <TableHead>{t("columns.lastSeen")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell className="font-medium">{device.name}</TableCell>
                    <TableCell>{device.location.name}</TableCell>
                    <TableCell>{device.register?.name ?? t("registerNone")}</TableCell>
                    <TableCell>
                      {device.lastSeenAt
                        ? format.dateTime(device.lastSeenAt, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : t("never")}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {device.revokedAt ? (
                          <Badge variant="secondary">{t("statusRevoked")}</Badge>
                        ) : (
                          <Badge variant="success">{t("statusActive")}</Badge>
                        )}
                        {device.pinLocked ? (
                          <Badge variant="destructive">{t("statusPinLocked")}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {device.revokedAt ? null : (
                        <div className="flex justify-end gap-2">
                          {device.pinLocked ? <UnlockPinButton deviceId={device.id} /> : null}
                          <RevokeDeviceButton
                            deviceId={device.id}
                            label={t("revoke")}
                            confirm={t("revokeConfirm", { name: device.name })}
                            successMessage={t("revoked")}
                          />
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
