import type { ReactNode } from 'react';
import AdminPortalShell from '@/components/admin-portal-shell';

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminPortalShell>{children}</AdminPortalShell>;
}
