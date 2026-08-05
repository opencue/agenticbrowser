async function(args) {
  if (!/^https?:$/.test(location.protocol)) {
    return { authenticated: false, email: null, error: 'not on the admin origin — run open_admin first' };
  }
  const res = await fetch('/admin/users/me', {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!res.ok) return { authenticated: false, email: null };
  const body = await res.json();
  return { authenticated: true, email: body?.user?.email ?? null };
}
