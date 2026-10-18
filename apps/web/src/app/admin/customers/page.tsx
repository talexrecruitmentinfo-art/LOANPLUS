'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiRequest } from '@/lib/api';

interface CustomerRecord {
  id: string;
  fullName: string;
  email: string;
  role: string;
  identityStatus: string;
  activationStatus: string;
  isActive: boolean;
  createdAt: string;
  _count: { paymentTransactions: number; loans: number; loanApplications: number };
}

export default function AdminCustomersPage() {
  const router = useRouter();
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async (searchTerm = '') => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (searchTerm.trim()) params.set('search', searchTerm.trim());
    try {
      setCustomers(await apiRequest<CustomerRecord[]>(`/admin/customers?${params.toString()}`, { cache: 'no-store' }));
    } catch (reason) {
      if (reason instanceof Error && reason.message.includes('Authentication required')) router.replace('/admin/login');
      setError(reason instanceof Error ? reason.message : 'Customer records could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void refresh(search);
  }

  return (
    <main className="dashboard-page admin-customers-page">
      <header className="dashboard-top"><Link className="wordmark" href="/admin"><span className="brand-mark">L+</span> loanplus <span className="admin-tag">ADMIN</span></Link><Link className="quiet-button" href="/admin">Overview</Link></header>
      <section className="dashboard-welcome"><p className="eyebrow">CUSTOMER MANAGEMENT</p><h1>Customer accounts.</h1><p>Read-only account overview. Identity numbers, phone numbers, payment payloads and password data are not exposed here.</p></section>
      <form className="admin-payment-filters" onSubmit={submit}><label>Search by name or email<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><button className="button button-small" type="submit">Search</button><button className="quiet-button" type="button" onClick={() => { setSearch(''); void refresh(''); }}>Clear</button></form>
      {error && <p className="admin-inline-error" role="alert">{error}</p>}
      <section className="admin-customer-list" aria-live="polite">{loading ? <p>Loading customer records…</p> : customers.length === 0 ? <p className="empty-copy">No matching accounts.</p> : customers.map((customer) => <article key={customer.id}><div className="admin-payment-heading"><div><b>{customer.fullName}</b><small>{customer.email}</small></div><span className={`status-label ${customer.isActive ? '' : 'status-failed'}`}>{customer.isActive ? 'ACCOUNT ENABLED' : 'ACCOUNT DISABLED'}</span></div><dl><div><dt>Activation</dt><dd>{customer.activationStatus.replaceAll('_', ' ')}</dd></div><div><dt>Identity review</dt><dd>{customer.identityStatus.replaceAll('_', ' ')}</dd></div><div><dt>Loan applications</dt><dd>{customer._count.loanApplications}</dd></div><div><dt>Loans</dt><dd>{customer._count.loans}</dd></div><div><dt>Payment records</dt><dd>{customer._count.paymentTransactions}</dd></div><div><dt>Registered</dt><dd>{new Date(customer.createdAt).toLocaleDateString('en-KE')}</dd></div></dl></article>)}</section>
    </main>
  );
}