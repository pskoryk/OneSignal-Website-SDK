import * as Browser from 'bowser';
import * as Cookie from 'js-cookie';
import * as log from 'loglevel';
import * as objectAssign from 'object-assign';

import Bell from '../bell/Bell';
import Environment from '../Environment';
import { InvalidStateError, InvalidStateReason } from '../errors/InvalidStateError';
import Event from '../Event';
import SdkEnvironment from '../managers/SdkEnvironment';
import { Uuid } from '../models/Uuid';
import { WindowEnvironmentKind } from '../models/WindowEnvironmentKind';
import OneSignalApi from '../OneSignalApi';
import Database from '../services/Database';
import { ResourceLoadState } from '../services/DynamicResourceLoader';
import {
  awaitOneSignalInitAndSupported,
  capitalize,
  contains,
  getConsoleStyle,
  getDeviceTypeForBrowser
} from '../utils';
import EventHelper from './EventHelper';
import SubscriptionHelper from './SubscriptionHelper';
import { WorkerMessengerCommand, WorkerMessenger } from '../libraries/WorkerMessenger';
import ProxyFrame from '../modules/frames/ProxyFrame';
import { NotificationPermission } from '../models/NotificationPermission';
import { InvalidArgumentError, InvalidArgumentReason } from '../errors/InvalidArgumentError';

export default class MainHelper {
  /**
   * If there are multiple manifests, and one of them is our OneSignal manifest, we move it to the top of <head> to ensure our manifest is used for push subscription (manifests after the first are ignored as part of the spec).
   */
  static fixWordpressManifestIfMisplaced() {
    var manifests = document.querySelectorAll('link[rel=manifest]');
    if (!manifests || manifests.length <= 1) {
      // Multiple manifests do not exist on this webpage; there is no issue
      return;
    }
    for (let i = 0; i < manifests.length; i++) {
      let manifest = manifests[i];
      let url = (manifest as any).href;
      if (contains(url, 'gcm_sender_id')) {
        // Move the <manifest> to the first thing in <head>
        document.querySelector('head').insertBefore(manifest, document.querySelector('head').children[0]);
        log.info('OneSignal: Moved the WordPress push <manifest> to the first element in <head>.');
      }
    }
  }

  /**
   * If the user has manually opted out of notifications (OneSignal.setSubscription), returns -2; otherwise returns 1.
   * @param isOptedIn The result of OneSignal.getSubscription().
   */
  static getNotificationTypeFromOptIn(isOptedIn) {
    if (isOptedIn == true || isOptedIn == null) {
      return 1;
    } else {
      return -2;
    }
  }

  /**
   * Returns true if a session cookie exists for noting the user dismissed the native prompt.
   */
  static wasHttpsNativePromptDismissed() {
    return Cookie.get('onesignal-notification-prompt') === 'dismissed';
  }

  /**
   * Stores a flag in sessionStorage that we've already shown the HTTP popover to this user and that we should not
   * show it again until they open a new window or tab to the site.
   */
  static markHttpPopoverShown() {
    sessionStorage.setItem('ONESIGNAL_HTTP_PROMPT_SHOWN', 'true');
  }

  /**
   * Returns true if the HTTP popover was already shown inside the same session.
   */
  static isHttpPromptAlreadyShown() {
    return sessionStorage.getItem('ONESIGNAL_HTTP_PROMPT_SHOWN') == 'true';
  }

  static checkAndTriggerNotificationPermissionChanged() {
    Promise.all([
      Database.get('Options', 'notificationPermission'),
      OneSignal.getNotificationPermission()
    ]).then(([previousPermission, currentPermission]) => {
      if (previousPermission !== currentPermission) {
        EventHelper.triggerNotificationPermissionChanged().then(() =>
          Database.put('Options', {
            key: 'notificationPermission',
            value: currentPermission
          })
        );
      }
    });
  }

  static showNotifyButton() {
    if (Environment.isBrowser() && !OneSignal.notifyButton) {
      OneSignal.config.userConfig.notifyButton = OneSignal.config.userConfig.notifyButton || {};
      if (OneSignal.config.userConfig.bell) {
        // If both bell and notifyButton, notifyButton's options take precedence
        objectAssign(OneSignal.config.userConfig.bell, OneSignal.config.userConfig.notifyButton);
        objectAssign(OneSignal.config.userConfig.notifyButton, OneSignal.config.userConfig.bell);
      }

      const displayPredicate: () => boolean = OneSignal.config.userConfig.notifyButton.displayPredicate;
      if (displayPredicate && typeof displayPredicate === 'function') {
        Promise.resolve(OneSignal.config.userConfig.notifyButton.displayPredicate()).then(predicateValue => {
          if (predicateValue !== false) {
            OneSignal.notifyButton = new Bell(OneSignal.config.userConfig.notifyButton);
            OneSignal.notifyButton.create();
          } else {
            log.debug('Notify button display predicate returned false so not showing the notify button.');
          }
        });
      } else {
        OneSignal.notifyButton = new Bell(OneSignal.config.userConfig.notifyButton);
        OneSignal.notifyButton.create();
      }
    }
  }

  static async getNotificationIcons() {
    const appId = await MainHelper.getAppId();
    if (!appId || !appId.value) {
      throw new InvalidStateError(InvalidStateReason.MissingAppId);
    }
    var url = `${SdkEnvironment.getOneSignalApiUrl().toString()}/apps/${appId.value}/icon`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.errors) {
      log.error(`API call %c${url}`, getConsoleStyle('code'), 'failed with:', data.errors);
      throw new Error('Failed to get notification icons.');
    }
    return data;
  }

  static establishServiceWorkerChannel() {
    const workerMessenger: WorkerMessenger = OneSignal.context.workerMessenger;
    workerMessenger.off();

    workerMessenger.on(WorkerMessengerCommand.NotificationDisplayed, data => {
      log.debug(location.origin, 'Received notification display event from service worker.');
      Event.trigger(OneSignal.EVENTS.NOTIFICATION_DISPLAYED, data);
    });

    workerMessenger.on(WorkerMessengerCommand.NotificationClicked, async data => {
      let clickedListenerCallbackCount: number;
      if (SdkEnvironment.getWindowEnv() === WindowEnvironmentKind.OneSignalProxyFrame) {
        clickedListenerCallbackCount = await new Promise<number>(resolve => {
          const proxyFrame: ProxyFrame = OneSignal.proxyFrame;
          if (proxyFrame) {
            proxyFrame.messenger.message(
              OneSignal.POSTMAM_COMMANDS.GET_EVENT_LISTENER_COUNT,
              OneSignal.EVENTS.NOTIFICATION_CLICKED,
              reply => {
                let callbackCount: number = reply.data;
                resolve(callbackCount);
              }
            );
          }
        });
      } else {
        clickedListenerCallbackCount = OneSignal.getListeners(OneSignal.EVENTS.NOTIFICATION_CLICKED).length;
      }
      if (clickedListenerCallbackCount === 0) {
        /*
          A site's page can be open but not listening to the
          notification.clicked event because it didn't call
          addListenerForNotificationOpened(). In this case, if there are no
          detected event listeners, we should save the event, instead of firing
          it without anybody recieving it.

          Or, since addListenerForNotificationOpened() only works once (you have
          to call it again each time), maybe it was only called once and the
          user isn't receiving the notification.clicked event for subsequent
          notifications on the same browser tab.

          Example: notificationClickHandlerMatch: 'origin', tab is clicked,
                   event fires without anybody listening, calling
                   addListenerForNotificationOpened() returns no results even
                   though a notification was just clicked.
        */
        log.debug(
          'notification.clicked event received, but no event listeners; storing event in IndexedDb for later retrieval.'
        );
        /* For empty notifications without a URL, use the current document's URL */
        let url = data.url;
        if (!data.url) {
          // Least likely to modify, since modifying this property changes the page's URL
          url = location.href;
        }
        await Database.put('NotificationOpened', { url: url, data: data, timestamp: Date.now() });
      } else {
        Event.trigger(OneSignal.EVENTS.NOTIFICATION_CLICKED, data);
      }
    });

    workerMessenger.on(WorkerMessengerCommand.RedirectPage, data => {
      log.debug(
        `${SdkEnvironment.getWindowEnv().toString()} Picked up command.redirect to ${data}, forwarding to host page.`
      );
      const proxyFrame: ProxyFrame = OneSignal.proxyFrame;
      if (proxyFrame) {
        proxyFrame.messenger.message(OneSignal.POSTMAM_COMMANDS.SERVICEWORKER_COMMAND_REDIRECT, data);
      }
    });

    workerMessenger.on(WorkerMessengerCommand.NotificationDismissed, data => {
      Event.trigger(OneSignal.EVENTS.NOTIFICATION_DISMISSED, data);
    });
  }

  static getPromptOptionsQueryString() {
    let promptOptions = OneSignal.config.userConfig.promptOptions;
    let promptOptionsStr = '';
    if (promptOptions) {
      let hash = MainHelper.getPromptOptionsPostHash();
      for (let key of Object.keys(hash)) {
        var value = hash[key];
        promptOptionsStr += '&' + key + '=' + value;
      }
    }
    return promptOptionsStr;
  }

  static getPromptOptionsPostHash() {
    let promptOptions = OneSignal.config.userConfig.promptOptions;
    if (promptOptions) {
      var legacyParams = {
        exampleNotificationTitleDesktop: 'exampleNotificationTitle',
        exampleNotificationMessageDesktop: 'exampleNotificationMessage',
        exampleNotificationTitleMobile: 'exampleNotificationTitle',
        exampleNotificationMessageMobile: 'exampleNotificationMessage'
      };
      for (let legacyParamKey of Object.keys(legacyParams)) {
        let legacyParamValue = legacyParams[legacyParamKey];
        if (promptOptions[legacyParamKey]) {
          promptOptions[legacyParamValue] = promptOptions[legacyParamKey];
        }
      }
      var allowedPromptOptions = [
        'autoAcceptTitle',
        'siteName',
        'autoAcceptTitle',
        'subscribeText',
        'showGraphic',
        'actionMessage',
        'exampleNotificationTitle',
        'exampleNotificationMessage',
        'exampleNotificationCaption',
        'acceptButtonText',
        'cancelButtonText',
        'timeout'
      ];
      var hash = {};
      for (var i = 0; i < allowedPromptOptions.length; i++) {
        var key = allowedPromptOptions[i];
        var value = promptOptions[key];
        var encoded_value = encodeURIComponent(value);
        if (value || value === false || value === '') {
          hash[key] = encoded_value;
        }
      }
    }
    return hash;
  }

  static triggerCustomPromptClicked(clickResult) {
    Event.trigger(OneSignal.EVENTS.CUSTOM_PROMPT_CLICKED, {
      result: clickResult
    });
  }

  static async getAppId(): Promise<Uuid> {
    if (OneSignal.config.appId) {
      return Promise.resolve(OneSignal.config.appId);
    } else {
      const uuid = await Database.get<string>('Ids', 'appId');
      return new Uuid(uuid);
    }
  }
}
