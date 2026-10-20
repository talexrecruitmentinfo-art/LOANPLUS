'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface StaffRole {
  role: string;
  label: string;
  permissions: string[];
}

interface StaffMember {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  role: string;
  isActive: boolean;
  status: string;
  invitationId: string | null;
  invitationExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

interface StaffAuditEvent {
  id: string;
  action: string;
  actorEmail: string | null;
  reason: string | null;
  details: unknown;
  createdAt: string;
  outcome: string;
}

const ROLE_OPTIONS: StaffRole[] = [
  { role: 'STAFF_SUPPORT', label: 'Support', permissions: ['support:read', 'support:reply'] },
  { role: 'STAFF_FINANCE', label: 'Finance', permissions: ['payments:read', 'reconciliation:read'] },
  { role: 'STAFF_OPERATIONS', label: 'Operations', permissions: ['loans:read'] },
];

export default function StaffAccountsPage() {
  const router = useRouter();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [roles, setRoles] = useState<StaffRole[]>(ROLE_OPTIONS);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, StaffAuditEvent[]>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (query: string) => {
    const result = await apiRequest<{ items: StaffMember[]; roles: StaffRole[] }>(
      `/admin/staff${query.trim() ? `?search=${encodeURIComponent(query.trim())}` : ''}`,
      { cache: 'no-store' },
    );
    setStaff(result.items);
    setRoles(result.roles);
    setSelectedRoles(Object.fromEntries(result.items.map((member) => [member.id, member.role])));
  }, []);

  useEffect(() => {
    refresh('').catch((cause) => {
      if (cause instanceof Error && cause.message.includes('Authentication required')) {
        router.replace('/admin/login');
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Staff accounts could not be loaded.');
    });
  }, [refresh, router]);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => refresh(search).catch((cause) => setError(cause instanceof Error ? cause.message : 'Staff search failed.')),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [refresh, search]);

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    setNotice('');
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      await apiRequest('/admin/staff', { method: 'POST', body: JSON.stringify(values) });
      setCreating(false);
      form.reset();
      await refresh(search);
      setNotice('Staff invitation sent. The recipient must complete account setup before signing in.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The staff account could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function runAction(
    member: StaffMember,
    action: string,
    path: string,
    method: 'POST' | 'PATCH',
    body: Record<string, unknown>,
  ) {
    if (!window.confirm(`${action} for ${member.fullName || member.email}?`)) return;
    const reason = window.prompt('Enter the administrative reason (10–500 characters):')?.trim();
    if (!reason || reason.length < 10 || reason.length > 500) {
      setError('A reason of 10 to 500 characters is required.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(path, { method, body: JSON.stringify({ ...body, reason }) });
      await refresh(search);
      setNotice(`${action} completed and audited.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${action} failed.`);
    } finally {
      setBusy(false);
    }
  }

  async function saveDetails(event: FormEvent<HTMLFormElement>, member: StaffMember) {
    event.preventDefault();
    const reason = new FormData(event.currentTarget).get('reason')?.toString().trim() ?? '';
    if (reason.length < 10 || reason.length > 500) {
      setError('A reason of 10 to 500 characters is required.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/admin/staff/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ fullName: editName, phone: editPhone || undefined, reason }),
      });
      setEditingId('');
      await refresh(search);
      setNotice('Staff details updated and audited.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff details could not be updated.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHistory(member: StaffMember) {
    if (history[member.id]) {
      setHistory((current) => {
        const next = { ...current };
        delete next[member.id];
        return next;
      });
      return;
    }
    try {
      const events = await apiRequest<StaffAuditEvent[]>(
        `/admin/staff/${encodeURIComponent(member.id)}/audit`,
        { cache: 'no-store' },
      );
      setHistory((current) => ({ ...current, [member.id]: events }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Staff audit history could not be loaded.');
    }
  }

  return (
    <main className="dashboard-page">
      <header className="dashboard-top">
        <Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link>
        <Link className="quiet-button" href="/admin">Administration</Link>
      </header>
      <section className="dashboard-welcome">
        <p className="eyebrow">ADMINISTRATION &amp; SECURITY</p>
        <h1>Staff Accounts.</h1>
        <p>Manage internal staff access. Customer accounts are not shown here. Every staff sign-in requires a fresh email verification code.</p>
      </section>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      {notice && <p className="admin-inline-notice" role="status">{notice}</p>}
      <section className="admin-workspace">
        <div className="admin-workspace-heading">
          <div><p className="eyebrow">USER &amp; ACCESS MANAGEMENT</p><h2>Staff Accounts</h2></div>
          <button className="button" type="button" onClick={() => setCreating((value) => !value)}>
            {creating ? 'Cancel' : 'Create Staff Account'}
          </button>
        </div>
        <label>Search staff<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or work email" /></label>
        {creating && <form className="product-config-form" onSubmit={(event) => void createAccount(event)}>
          <h3>Create Staff Account</h3>
          <label>Full name<input name="fullName" minLength={2} maxLength={160} required /></label>
          <label>Unique work email<input name="email" type="email" maxLength={254} autoComplete="off" required /></label>
          <label>Phone number (optional)<input name="phone" type="tel" pattern="\+?[\d ()-]{9,18}" /></label>
          <label>Staff role<select name="role" defaultValue="" required>
            <option value="" disabled>Choose a least-privilege role</option>
            {roles.map((role) => <option value={role.role} key={role.role}>{role.label}</option>)}
          </select></label>
          <label>Administrative reason<textarea name="reason" minLength={10} maxLength={500} rows={2} required /></label>
          <p className="settings-copy">The invitation is single-use and expires after 24 hours. No password is created or disclosed by this form.</p>
          <button className="button" disabled={busy}>{busy ? 'Creating…' : 'Create account and send invitation'}</button>
        </form>}
        <div className="admin-product-list" aria-label="Staff accounts">
          {staff.map((member) => {
            const role = roles.find((option) => option.role === member.role);
            return <article key={member.id}>
              <div>
                <b>{member.fullName || 'Name not set'} · {member.email}</b>
                <small>{role?.label ?? member.role} · {member.status.replaceAll('_', ' ')} · Created {new Date(member.createdAt).toLocaleDateString('en-KE')}</small>
                <small>{member.phone ? `Phone ${member.phone} · ` : ''}Last login {member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString('en-KE') : 'Never'}</small>
                {member.status === 'INVITATION_PENDING' && member.invitationExpiresAt &&
                  <small>Invitation expires {new Date(member.invitationExpiresAt).toLocaleString('en-KE')}</small>}
                <small>Access: {role?.permissions.join(', ') ?? 'No access assigned'}</small>
                <div className="staff-account-actions">
                  <button className="quiet-button" type="button" onClick={() => {
                    setEditingId(member.id);
                    setEditName(member.fullName);
                    setEditPhone(member.phone ?? '');
                  }}>Edit details</button>
                  <label>Role<select value={selectedRoles[member.id] ?? member.role}
                    onChange={(event) => setSelectedRoles((current) => ({ ...current, [member.id]: event.target.value }))}>
                    {roles.map((option) => <option value={option.role} key={option.role}>{option.label}</option>)}
                  </select></label>
                  <button className="quiet-button" type="button" disabled={busy || selectedRoles[member.id] === member.role}
                    onClick={() => void runAction(
                      member,
                      'Role change',
                      `/admin/staff/${encodeURIComponent(member.id)}/role`,
                      'PATCH',
                      { role: selectedRoles[member.id] },
                    )}>Save role</button>
                  <button className="quiet-button" type="button" disabled={busy}
                    onClick={() => void runAction(
                      member,
                      member.isActive ? 'Suspend account and revoke sessions' : 'Reactivate account',
                      `/admin/staff/${encodeURIComponent(member.id)}/status`,
                      'PATCH',
                      { isActive: !member.isActive },
                    )}>{member.isActive ? 'Suspend' : 'Reactivate'}</button>
                  <button className="quiet-button" type="button" disabled={busy}
                    onClick={() => void runAction(
                      member,
                      'Revoke active staff sessions',
                      `/admin/staff/${encodeURIComponent(member.id)}/sessions/revoke`,
                      'POST',
                      {},
                    )}>Revoke sessions</button>
                  {!member.status.startsWith('ACTIVE') && member.status !== 'SUSPENDED' && <button className="quiet-button" type="button" disabled={busy}
                    onClick={() => void runAction(
                      member,
                      'Resend invitation',
                      `/admin/staff/${encodeURIComponent(member.id)}/invitations/resend`,
                      'POST',
                      {},
                    )}>Resend invitation</button>}
                  {member.invitationId && member.status === 'INVITATION_PENDING' && <button className="quiet-button" type="button" disabled={busy}
                    onClick={() => void runAction(
                      member,
                      'Revoke invitation',
                      `/admin/staff/${encodeURIComponent(member.id)}/invitations/${encodeURIComponent(member.invitationId!)}/revoke`,
                      'POST',
                      {},
                    )}>Revoke invitation</button>}
                  <button className="quiet-button" type="button" onClick={() => void toggleHistory(member)}>
                    {history[member.id] ? 'Hide audit history' : 'View audit history'}
                  </button>
                </div>
                {editingId === member.id && <form className="product-config-form" onSubmit={(event) => void saveDetails(event, member)}>
                  <label>Full name<input value={editName} onChange={(event) => setEditName(event.target.value)} minLength={2} maxLength={160} required /></label>
                  <label>Phone number<input type="tel" value={editPhone} onChange={(event) => setEditPhone(event.target.value)} pattern="\+?[\d ()-]{9,18}" /></label>
                  <label>Reason<textarea name="reason" minLength={10} maxLength={500} rows={2} required /></label>
                  <button className="button" disabled={busy}>Save details</button>
                  <button className="quiet-button" type="button" onClick={() => setEditingId('')}>Cancel</button>
                </form>}
                {history[member.id]?.map((event) => <details key={event.id} className="transaction-details">
                  <summary>{event.action.replaceAll('_', ' ')} · {new Date(event.createdAt).toLocaleString('en-KE')}</summary>
                  <p>Actor {event.actorEmail ?? 'Unknown'} · {event.outcome} · {event.reason ?? 'No reason recorded'}</p>
                  <pre>{JSON.stringify(event.details, null, 2)}</pre>
                </details>)}
              </div>
            </article>;
          })}
          {staff.length === 0 && <p className="empty-copy">No staff accounts match this search.</p>}
        </div>
      </section>
    </main>
  );
}
