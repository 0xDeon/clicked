'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/useAuth';
import { apiFetch } from '@/lib/api';
import { Modal } from '@/components/ui/Modal';

type Device = {
  id: string;
  identityPublicKey: string;
  deviceName: string | null;
  platform: 'web' | 'ios' | 'android' | null;
  lastSeenAt: string | null;
  isRevoked: boolean;
  createdAt: string;
  current: boolean;
};

function formatLastSeen(lastSeenAt: string | null) {
  if (!lastSeenAt) return 'Never';
  const date = new Date(lastSeenAt);
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function platformLabel(platform: Device['platform']) {
  if (platform === 'web') return 'Web';
  if (platform === 'ios') return 'iOS';
  if (platform === 'android') return 'Android';
  return 'Unknown';
}

export default function DevicesPage() {
  const { token } = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [confirmLogoutEverywhere, setConfirmLogoutEverywhere] = useState(false);

  const fetchDevices = useCallback(async () => {
    if (!token) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await apiFetch('/devices', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to load your devices.');
      }

      const data = (await response.json()) as Device[];
      setDevices(data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load your devices.');
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  async function revokeDevice(deviceId: string) {
    if (!token) return;
    setPendingDeviceId(deviceId);
    setActionError(null);

    try {
      const response = await apiFetch(`/devices/${deviceId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to revoke device.');
      }

      setDevices((current) =>
        current.map((device) => (device.id === deviceId ? { ...device, isRevoked: true } : device)),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to revoke device.');
    } finally {
      setPendingDeviceId(null);
      setConfirmRevokeId(null);
    }
  }

  async function logoutEverywhere() {
    if (!token) return;
    setPendingDeviceId('__logout_everywhere__');
    setActionError(null);

    try {
      const response = await apiFetch('/devices/logout-everywhere', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to log out other devices.');
      }

      await fetchDevices();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to log out other devices.');
    } finally {
      setPendingDeviceId(null);
      setConfirmLogoutEverywhere(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-[var(--foreground)]/50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--border)] border-t-[var(--accent)]" />
        <p className="text-sm font-medium">Loading your devices...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="max-w-md rounded-lg border border-red-500/20 bg-red-500/5 p-6">
          <h2 className="text-lg font-semibold text-red-300">Unable to load devices</h2>
          <p className="mt-2 text-sm text-[var(--foreground)]/60">{loadError}</p>
          <button
            type="button"
            onClick={() => void fetchDevices()}
            className="mt-4 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/30"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const otherActiveDevices = devices.filter((device) => !device.current && !device.isRevoked);

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 text-[var(--foreground)]">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Linked Devices</h2>
          <p className="mt-1 text-sm text-[var(--foreground)]/45">
            Devices signed in to your account. Revoking a device immediately ends its session and
            rotates the keys it can use to read new messages.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setConfirmLogoutEverywhere(true)}
          disabled={otherActiveDevices.length === 0 || pendingDeviceId !== null}
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Log out everywhere else
        </button>
      </div>

      <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--card)]/40 p-4">
        <h3 className="text-sm font-semibold">Link a new device</h3>
        <p className="mt-1 text-sm text-[var(--foreground)]/45">
          Open Clicked on the new device and connect the same wallet. It registers automatically
          and shows up in the list below the moment it signs in.
        </p>
      </div>

      {actionError ? (
        <p className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200">
          {actionError}
        </p>
      ) : null}

      <div className="space-y-3">
        {devices.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--foreground)]/40">No devices found.</p>
        ) : (
          devices.map((device) => (
            <div
              key={device.id}
              className={`flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4 ${
                device.isRevoked
                  ? 'border-[var(--border)] bg-[var(--background)]/20 opacity-50'
                  : 'border-[var(--border)] bg-[var(--card)]/40'
              }`}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{device.deviceName ?? 'Unnamed device'}</p>
                  {device.current ? (
                    <span className="inline-flex rounded-full border border-[var(--accent)]/10 bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-light)]">
                      This device
                    </span>
                  ) : null}
                  {device.isRevoked ? (
                    <span className="inline-flex rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-300">
                      Revoked
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-[var(--foreground)]/45">
                  {platformLabel(device.platform)} · Last seen {formatLastSeen(device.lastSeenAt)}
                </p>
              </div>

              {!device.isRevoked ? (
                <button
                  type="button"
                  onClick={() => setConfirmRevokeId(device.id)}
                  disabled={pendingDeviceId !== null}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--foreground)]/70 transition-colors hover:border-red-500/40 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {pendingDeviceId === device.id ? 'Revoking...' : 'Revoke'}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      <Modal
        isOpen={confirmRevokeId !== null}
        onClose={() => setConfirmRevokeId(null)}
        title="Revoke this device?"
      >
        <p className="text-sm text-[var(--foreground)]/60">
          This device will be signed out immediately. Because your identity keys change for
          anyone who messages you on this account, contacts may see a key-change notice the next
          time they message you — that&apos;s expected and confirms the old device can no longer
          read new messages.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setConfirmRevokeId(null)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => confirmRevokeId && void revokeDevice(confirmRevokeId)}
            className="rounded-lg bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30"
          >
            Revoke device
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={confirmLogoutEverywhere}
        onClose={() => setConfirmLogoutEverywhere(false)}
        title="Log out everywhere else?"
      >
        <p className="text-sm text-[var(--foreground)]/60">
          Every device except this one will be signed out and its keys revoked. Contacts may see a
          key-change notice the next time they message you.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={() => setConfirmLogoutEverywhere(false)}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void logoutEverywhere()}
            className="rounded-lg bg-red-500/20 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/30"
          >
            Log out everywhere else
          </button>
        </div>
      </Modal>
    </div>
  );
}
