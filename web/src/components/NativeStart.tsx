"use client";
// Starts the Android app's native handling (back button, invite links); does
// nothing on the website. See lib/native.ts.

import { useEffect } from "react";
import { startNative } from "@/lib/native";

export default function NativeStart() {
  useEffect(() => {
    void startNative();
  }, []);
  return null;
}
