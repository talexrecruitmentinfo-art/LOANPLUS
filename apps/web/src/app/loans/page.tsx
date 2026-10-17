'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';

interface Product {
  id: string;
  name: string;
  description: string;
  minimumPrincipalKes: number;
  maximumPrincipalKes: number;
  durationDays: number;
  interestRateBps: number;
  flatFeeKes: number;
  termsVersion: string;
}

const formatKes = (amount: number) => `KSh ${new Intl.NumberFormat('en-KE').format(amount)}`;

export default function LoanProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest<Product[]>('/loans/products').then(setProducts).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Products could not be loaded.');
    }).finally(() => setLoading(false));
  }, []);

  return <main className="dashboard-page"><header className="dashboard-top"><Link className="wordmark" href="/"><span className="brand-mark">L+</span> loanplus</Link><Link className="quiet-button" href="/dashboard">My account</Link></header><section className="dashboard-welcome"><p className="eyebrow">LOAN PRODUCTS</p><h1>Clear terms first.</h1><p>Products are shown only when configured by LoanPlus. Review charges and repayment dates before accepting any offer. Approval is not guaranteed.</p></section><section className="product-list">{loading ? <p>Loading configured products…</p> : error ? <p className="form-error" role="alert">{error}</p> : products.length === 0 ? <div className="dashboard-empty"><p className="eyebrow">NO PRODUCTS AVAILABLE</p><h2>There are no active loan products.</h2><p>Loan terms will appear here when they have been configured and approved.</p></div> : products.map((product) => <article className="product-row" key={product.id}><div><p className="eyebrow">{product.durationDays} DAY TERM</p><h2>{product.name}</h2><p>{product.description}</p></div><dl><div><dt>Principal range</dt><dd>{formatKes(product.minimumPrincipalKes)} – {formatKes(product.maximumPrincipalKes)}</dd></div><div><dt>Interest</dt><dd>{(product.interestRateBps / 100).toFixed(2)}%</dd></div><div><dt>Fixed charge</dt><dd>{formatKes(product.flatFeeKes)}</dd></div><div><dt>Terms version</dt><dd>{product.termsVersion}</dd></div></dl><p className="product-disclosure">Final total repayment and dates depend on the approved offer. You must review the full terms before accepting.</p><Link className="button" href="/login">Sign in to apply <span aria-hidden="true">↗</span></Link></article>)}</section></main>;
}