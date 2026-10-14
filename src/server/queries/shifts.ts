import "server-only";

export interface OpenShift {
  id: string;
  registerId: string;
  locationId: string;
  openedAt: Date;
  openingFloat: bigint;
}

/** The open shift on the current device's register, or null. STUB. */
export async function getOpenShift(): Promise<OpenShift | null> {
  return null;
}
