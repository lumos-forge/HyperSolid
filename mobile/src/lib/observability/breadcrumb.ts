/**
 * Observability seam for ledger lifecycle events (persist / reconcile / orphan / retry / recovery).
 * Kept dependency-free and injectable so unit tests can assert events fire. The default is a no-op;
 * the production EAS build wires this to `Sentry.addBreadcrumb` (Sentry is not yet a dependency —
 * it requires the native EAS build, so it is intentionally not imported here).
 */
export type BreadcrumbData = Record<string, unknown>;
export type Breadcrumb = (event: string, data?: BreadcrumbData) => void;

export const noopBreadcrumb: Breadcrumb = () => {};
