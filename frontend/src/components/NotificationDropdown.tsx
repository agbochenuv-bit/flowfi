import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  useNotificationPreferences,
  NotificationEventType,
} from '../hooks/useNotificationPreferences';

export interface StreamNotification {
  id: string;
  eventType: NotificationEventType;
  streamId: string;
  title: string;
  message: string;
  createdAt: string;
  /** Optional dedupe key; defaults to `${eventType}:${streamId}` */
  dedupeKey?: string;
}

export interface NotificationDropdownProps {
  /** Wallet address used to scope preferences. */
  walletAddress?: string | null;
  /** Raw notifications from the backend / websocket. */
  notifications: StreamNotification[];
  /** Called when the dropdown is opened (e.g. to mark as read). */
  onOpen?: () => void;
  /** Called when a notification is clicked. */
  onNotificationClick?: (notification: StreamNotification) => void;
  /** Optional class name for the root element. */
  className?: string;
}

const EVENT_LABELS: Record<NotificationEventType, string> = {
  created: 'Stream created',
  funded: 'Stream funded',
  paused: 'Stream paused',
  resumed: 'Stream resumed',
  completed: 'Stream completed',
  cancelled: 'Stream cancelled',
  withdrawn: 'Funds withdrawn',
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

/**
 * Deduplicate notifications by their dedupe key, keeping the most recent
 * occurrence (by createdAt, falling back to input order).
 */
export function dedupeNotifications(
  notifications: StreamNotification[],
): StreamNotification[] {
  const byKey = new Map<string, StreamNotification>();
  notifications.forEach((notification, index) => {
    const key =
      notification.dedupeKey ?? `${notification.eventType}:${notification.streamId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, notification);
      return;
    }
    const existingTime = new Date(existing.createdAt).getTime();
    const incomingTime = new Date(notification.createdAt).getTime();
    const existingValid = !Number.isNaN(existingTime);
    const incomingValid = !Number.isNaN(incomingTime);
    if (incomingValid && existingValid) {
      if (incomingTime >= existingTime) {
        byKey.set(key, notification);
      }
    } else if (!existingValid && incomingValid) {
      byKey.set(key, notification);
    } else if (!existingValid && !incomingValid) {
      // Keep the later one in input order as a stable tiebreaker.
      byKey.set(key, notification);
    }
    void index;
  });
  return Array.from(byKey.values());
}

/**
 * Filter notifications to those whose event type is enabled for in-app display.
 */
export function filterNotificationsByPreferences(
  notifications: StreamNotification[],
  isEventEnabled: (eventType: NotificationEventType) => boolean,
): StreamNotification[] {
  return notifications.filter((notification) =>
    isEventEnabled(notification.eventType),
  );
}

export function streamDeepLink(streamId: string): string {
  return `/streams/${encodeURIComponent(streamId)}`;
}

const NotificationDropdown: React.FC<NotificationDropdownProps> = ({
  walletAddress,
  notifications,
  onOpen,
  onNotificationClick,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const {
    preferences,
    isEventEnabled,
    browserPermission,
    requestBrowserPermission,
  } = useNotificationPreferences(walletAddress);

  const visibleNotifications = useMemo(() => {
    if (!preferences.inAppEnabled) return [];
    const filtered = filterNotificationsByPreferences(
      notifications,
      isEventEnabled,
    );
    return dedupeNotifications(filtered);
  }, [notifications, preferences.inAppEnabled, isEventEnabled]);

  const unreadCount = visibleNotifications.length;

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        onOpen?.();
      }
      return next;
    });
  }, [onOpen]);

  const handleNotificationClick = useCallback(
    (notification: StreamNotification) => {
      onNotificationClick?.(notification);
      setIsOpen(false);
      navigate(streamDeepLink(notification.streamId));
    },
    [navigate, onNotificationClick],
  );

  const handleRequestPermission = useCallback(() => {
    void requestBrowserPermission();
  }, [requestBrowserPermission]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const showPermissionNotice =
    preferences.browserEnabled && browserPermission === 'denied';
  const showOptOutNotice = !preferences.inAppEnabled;

  return (
    <div
      ref={rootRef}
      className={['notification-dropdown', className].filter(Boolean).join(' ')}
      data-testid="notification-dropdown"
    >
      <button
        type="button"
        className="notification-dropdown__trigger"
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        onClick={handleToggle}
        data-testid="notification-dropdown-trigger"
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span
            className="notification-dropdown__badge"
            data-testid="notification-dropdown-badge"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          className="notification-dropdown__panel"
          role="menu"
          data-testid="notification-dropdown-panel"
        >
          <div className="notification-dropdown__header">
            <span>Notifications</span>
          </div>

          {showOptOutNotice && (
            <div
              className="notification-dropdown__notice"
              role="status"
              data-testid="notification-opt-out-notice"
            >
              In-app notifications are turned off. Enable them in notification
              settings to see stream updates here.
            </div>
          )}

          {showPermissionNotice && (
            <div
              className="notification-dropdown__notice notification-dropdown__notice--warning"
              role="status"
              data-testid="notification-permission-denied-notice"
            >
              Browser notifications are blocked. Update your browser site
              settings to allow notifications.
              <button
                type="button"
                className="notification-dropdown__notice-action"
                onClick={handleRequestPermission}
              >
                Retry
              </button>
            </div>
          )}

          {!showOptOutNotice && visibleNotifications.length === 0 && (
            <div
              className="notification-dropdown__empty"
              data-testid="notification-dropdown-empty"
            >
              No notifications
            </div>
          )}

          {!showOptOutNotice && visibleNotifications.length > 0 && (
            <ul className="notification-dropdown__list">
              {visibleNotifications.map((notification) => (
                <li key={notification.id} className="notification-dropdown__item">
                  <Link
                    to={streamDeepLink(notification.streamId)}
                    className="notification-dropdown__link"
                    role="menuitem"
                    data-testid={`notification-item-${notification.id}`}
                    data-stream-id={notification.streamId}
                    data-event-type={notification.eventType}
                    onClick={(event) => {
                      event.preventDefault();
                      handleNotificationClick(notification);
                    }}
                  >
                    <span className="notification-dropdown__title">
                      {notification.title ||
                        EVENT_LABELS[notification.eventType] ||
                        'Stream update'}
                    </span>
                    <span className="notification-dropdown__message">
                      {notification.message}
                    </span>
                    <span className="notification-dropdown__time">
                      {formatTimestamp(notification.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationDropdown;