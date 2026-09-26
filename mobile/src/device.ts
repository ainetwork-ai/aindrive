/**
 * Which device this shell runs on. The same shell is the phone app (Android,
 * iOS) and the Mac app (desktop/, whose bridge reports the platform "electron"),
 * so copy that names the device, and features only a phone has — call
 * recordings and the camera roll as agent sources, on-device recognition
 * models, Google's account picker — go through here.
 */
import { Capacitor } from "@capacitor/core";

export const ON_MAC = Capacitor.getPlatform() === "electron";
/** "phone" or "Mac", for "this phone" / "your Mac" in copy. */
export const DEVICE = ON_MAC ? "Mac" : "phone";
