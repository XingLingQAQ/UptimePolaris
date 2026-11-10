export interface MaintenanceContent {
  title: string;
  description: string;
}

export interface PublicMaintenancePeriod extends MaintenanceContent {
  startsAt: string;
  endsAt: string;
}

export interface PublicMaintenanceState extends MaintenanceContent {
  active: boolean;
  source: 'manual' | 'scheduled' | null;
  serverNow: string;
  startsAt: string | null;
  endsAt: string | null;
  scheduled: PublicMaintenancePeriod[];
}
