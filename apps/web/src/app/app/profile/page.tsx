'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/components/auth/useAuth';
import { apiFetch } from '@/lib/api';

type FieldErrors = {
  username?: string;
  avatarUrl?: string;
  form?: string;
};

type Wallet = {
  address: string;
  isPrimary: boolean;
};

type UserProfile = {
  id: string;
  username: string | null;
  avatarUrl: string | null;
  wallets: Wallet[];
  presenceVisible: boolean;
  lastSeenVisible: boolean;
  sendReadReceipts: boolean;
  allowDirectMessages: boolean;
  allowGroupInvites: boolean;
};

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,30}$/;

function truncateAddress(address: string) {
  if (address.length <= 16) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function getApiErrorMessage(payload: unknown) {
  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string'
  ) {
    return payload.message;
  }

  return 'Unable to save profile. Please try again.';
}

function mapApiErrors(status: number, payload: unknown): FieldErrors {
  const message = getApiErrorMessage(payload);
  const normalized = message.toLowerCase();

  if (status === 409 || normalized.includes('taken') || normalized.includes('conflict')) {
    return { username: 'Username is already taken.' };
  }

  if (normalized.includes('username')) {
    return { username: message };
  }

  if (normalized.includes('avatar')) {
    return { avatarUrl: message };
  }

  return { form: message };
}

export default function ProfilePage() {
  const { token } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [username, setUsername] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [presenceVisible, setPresenceVisible] = useState(false);
  const [lastSeenVisible, setLastSeenVisible] = useState(false);
  const [sendReadReceipts, setSendReadReceipts] = useState(false);
  const [allowDirectMessages, setAllowDirectMessages] = useState(true);
  const [allowGroupInvites, setAllowGroupInvites] = useState(false);

  const fetchProfile = useCallback(async () => {
    if (!token) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);

    try {
      const response = await apiFetch('/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error('Failed to load user profile.');
      }

      const data = (await response.json()) as UserProfile;
      setProfile(data);
      setUsername(data.username ?? '');
      setAvatarUrl(data.avatarUrl ?? '');
      setPresenceVisible(data.presenceVisible);
      setLastSeenVisible(data.lastSeenVisible);
      setSendReadReceipts(data.sendReadReceipts);
      setAllowDirectMessages(data.allowDirectMessages);
      setAllowGroupInvites(data.allowGroupInvites);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load user profile.');
    } finally {
      setIsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (!showSuccessToast) return;

    const timeoutId = window.setTimeout(() => {
      setShowSuccessToast(false);
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [showSuccessToast]);

  function validateForm() {
    const nextErrors: FieldErrors = {};
    const trimmedUsername = username.trim();
    const trimmedAvatarUrl = avatarUrl.trim();

    if (!trimmedUsername) {
      nextErrors.username = 'Username is required.';
    } else if (!USERNAME_PATTERN.test(trimmedUsername)) {
      nextErrors.username = 'Use 3-30 letters, numbers, or underscores.';
    }

    if (trimmedAvatarUrl) {
      try {
        const parsedUrl = new URL(trimmedAvatarUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          nextErrors.avatarUrl = 'Avatar URL must start with http:// or https://.';
        }
      } catch {
        nextErrors.avatarUrl = 'Enter a valid avatar URL.';
      }
    }

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowSuccessToast(false);

    if (!validateForm()) return;

    setIsSaving(true);
    setFieldErrors({});

    try {
      const nextUsername = username.trim();
      const nextAvatarUrl = avatarUrl.trim();
      const response = await apiFetch('/users/me', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          username: nextUsername,
          avatarUrl: nextAvatarUrl || null,
          presenceVisible,
          lastSeenVisible,
          sendReadReceipts,
          allowDirectMessages,
          allowGroupInvites,
        }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        setFieldErrors(mapApiErrors(response.status, data));
        return;
      }

      setProfile((currentProfile) =>
        currentProfile
          ? {
              ...currentProfile,
              username: nextUsername,
              avatarUrl: nextAvatarUrl || null,
              presenceVisible,
              lastSeenVisible,
              sendReadReceipts,
              allowDirectMessages,
              allowGroupInvites,
            }
          : currentProfile,
      );
      setShowSuccessToast(true);
      window.dispatchEvent(new Event('profile-updated'));
    } catch {
      setFieldErrors({ form: 'Unable to save profile. Please try again.' });
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-[var(--foreground)]/50">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--border)] border-t-[var(--accent)]" />
        <p className="text-sm font-medium">Loading your profile...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="max-w-md rounded-lg border border-red-500/20 bg-red-500/5 p-6">
          <h2 className="text-lg font-semibold text-red-300">Unable to load profile</h2>
          <p className="mt-2 text-sm text-[var(--foreground)]/60">{loadError}</p>
          <button
            type="button"
            onClick={() => void fetchProfile()}
            className="mt-4 rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/30"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-5xl px-6 py-8 text-[var(--foreground)]">
      <div
        role="status"
        aria-live="polite"
        className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border border-emerald-500/30 bg-emerald-950/90 px-5 py-4 shadow-2xl transition-all duration-300 ${
          showSuccessToast
            ? 'translate-y-0 opacity-100'
            : 'pointer-events-none translate-y-3 opacity-0'
        }`}
      >
        <p className="text-sm font-semibold text-white">Profile saved</p>
        <p className="mt-1 text-xs text-emerald-200/80">Your changes were saved successfully.</p>
      </div>

      <div className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight">Profile Settings</h2>
        <p className="mt-1 text-sm text-[var(--foreground)]/45">
          Manage your username, avatar, privacy preferences, and connected Stellar wallets.
        </p>
      </div>

      <div className="grid gap-8 md:grid-cols-5">
        <section className="rounded-lg border border-[var(--border)] bg-[var(--card)]/40 p-6 md:col-span-3">
          <h3 className="mb-6 text-lg font-semibold">Edit Profile</h3>

          <form onSubmit={handleSubmit} className="space-y-6" noValidate>
            <div className="flex items-center gap-4">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt="Avatar preview"
                  onError={(event) => {
                    event.currentTarget.src = `https://api.dicebear.com/7.x/bottts/svg?seed=${username || 'clicked'}`;
                  }}
                  className="h-16 w-16 rounded-full border-2 border-[var(--accent)] bg-[var(--border)] object-cover shadow-lg"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--border)] bg-[var(--muted)]/50 text-xl font-bold text-[var(--foreground)]/60">
                  {username ? username.slice(0, 2).toUpperCase() : 'U'}
                </div>
              )}
              <div>
                <h4 className="text-sm font-semibold">Avatar</h4>
                <p className="text-xs text-[var(--foreground)]/45">
                  Use an image URL for your profile picture.
                </p>
              </div>
            </div>

            <div>
              <label
                htmlFor="username"
                className="mb-2 block text-sm font-semibold text-[var(--foreground)]/80"
              >
                Username
              </label>
              <input
                id="username"
                name="username"
                type="text"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setFieldErrors((errors) => ({ ...errors, username: undefined, form: undefined }));
                }}
                aria-invalid={Boolean(fieldErrors.username)}
                aria-describedby="username-help username-error"
                placeholder="crypto_champ"
                className={`w-full rounded-lg border bg-[var(--background)] px-4 py-2.5 text-sm outline-none transition-all focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] ${
                  fieldErrors.username
                    ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/50'
                    : 'border-[var(--border)]'
                }`}
              />
              {fieldErrors.username ? (
                <p id="username-error" className="mt-1.5 text-xs font-medium text-red-300">
                  {fieldErrors.username}
                </p>
              ) : null}
              <p id="username-help" className="mt-1.5 text-xs text-[var(--foreground)]/35">
                3 to 30 characters. Letters, numbers, and underscores only.
              </p>
            </div>

            <div>
              <label
                htmlFor="avatarUrl"
                className="mb-2 block text-sm font-semibold text-[var(--foreground)]/80"
              >
                Avatar URL
              </label>
              <input
                id="avatarUrl"
                name="avatarUrl"
                type="url"
                value={avatarUrl}
                onChange={(event) => {
                  setAvatarUrl(event.target.value);
                  setFieldErrors((errors) => ({
                    ...errors,
                    avatarUrl: undefined,
                    form: undefined,
                  }));
                }}
                aria-invalid={Boolean(fieldErrors.avatarUrl)}
                aria-describedby={fieldErrors.avatarUrl ? 'avatarUrl-error' : undefined}
                placeholder="https://example.com/avatar.png"
                className={`w-full rounded-lg border bg-[var(--background)] px-4 py-2.5 text-sm outline-none transition-all focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] ${
                  fieldErrors.avatarUrl
                    ? 'border-red-500/60 focus:border-red-500 focus:ring-red-500/50'
                    : 'border-[var(--border)]'
                }`}
              />
              {fieldErrors.avatarUrl ? (
                <p id="avatarUrl-error" className="mt-1.5 text-xs font-medium text-red-300">
                  {fieldErrors.avatarUrl}
                </p>
              ) : null}
            </div>

            <div className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-4">
              <div>
                <h4 className="text-sm font-semibold text-[var(--foreground)]">Privacy controls</h4>
                <p className="mt-1 text-xs text-[var(--foreground)]/45">
                  Keep metadata private by default and opt into what other people can see.
                </p>
              </div>

              {[
                {
                  id: 'presenceVisible',
                  label: 'Show online presence',
                  description: 'Let other users see when you are currently online.',
                  checked: presenceVisible,
                  onChange: setPresenceVisible,
                },
                {
                  id: 'lastSeenVisible',
                  label: 'Share last seen',
                  description: 'Expose your last active timestamp when you are offline.',
                  checked: lastSeenVisible,
                  onChange: setLastSeenVisible,
                },
                {
                  id: 'sendReadReceipts',
                  label: 'Send read receipts',
                  description: 'Allow the server to fan out read receipts after you open messages.',
                  checked: sendReadReceipts,
                  onChange: setSendReadReceipts,
                },
                {
                  id: 'allowDirectMessages',
                  label: 'Allow direct messages',
                  description: 'Permit new one-to-one conversations to be created with your account.',
                  checked: allowDirectMessages,
                  onChange: setAllowDirectMessages,
                },
                {
                  id: 'allowGroupInvites',
                  label: 'Allow group invites',
                  description: 'Permit other members to add you to group conversations.',
                  checked: allowGroupInvites,
                  onChange: setAllowGroupInvites,
                },
              ].map((setting) => (
                <label
                  key={setting.id}
                  htmlFor={setting.id}
                  className="flex items-start justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--card)]/40 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium text-[var(--foreground)]">{setting.label}</p>
                    <p className="mt-1 text-xs text-[var(--foreground)]/45">
                      {setting.description}
                    </p>
                  </div>
                  <input
                    id={setting.id}
                    type="checkbox"
                    checked={setting.checked}
                    onChange={(event) => {
                      setting.onChange(event.target.checked);
                      setFieldErrors((errors) => ({ ...errors, form: undefined }));
                    }}
                    className="mt-1 h-4 w-4 rounded border-[var(--border)] bg-[var(--background)] text-[var(--accent)]"
                  />
                </label>
              ))}
            </div>

            {fieldErrors.form ? (
              <p className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200">
                {fieldErrors.form}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={isSaving || !token}
              className="inline-flex items-center justify-center rounded-lg bg-[var(--accent)] px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[var(--accent)]/15 transition-all hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-[var(--border)] bg-[var(--card)]/40 p-6 md:col-span-2">
          <h3 className="mb-6 text-lg font-semibold">Connected Wallets</h3>

          <div className="space-y-3">
            {profile?.wallets.length ? (
              profile.wallets.map((wallet) => (
                <div
                  key={wallet.address}
                  className="rounded-lg border border-[var(--border)] bg-[var(--background)]/30 p-4"
                >
                  <p
                    className="truncate font-mono text-xs text-[var(--foreground)]/70"
                    title={wallet.address}
                  >
                    {truncateAddress(wallet.address)}
                  </p>
                  {wallet.isPrimary ? (
                    <span className="mt-2 inline-flex rounded-full border border-[var(--accent)]/10 bg-[var(--accent)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-light)]">
                      Primary Wallet
                    </span>
                  ) : null}
                </div>
              ))
            ) : (
              <p className="py-6 text-center text-sm text-[var(--foreground)]/40">
                No connected wallets found.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
