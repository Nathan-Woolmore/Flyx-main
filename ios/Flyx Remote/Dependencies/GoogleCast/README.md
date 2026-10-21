# Google Cast dependency

This local manifest references Google's unchanged SDK4.8.6 dynamic XCFramework at its official URL, pinned to the checksum in Google's4.8.6 package manifest. It contains no copied SDK binary or private paths.

The upstream GoogleCastDynamic product also links GTMSessionFetcher statically. Binary inspection and the app launch console confirmed duplicate GTM Objective-C classes in GoogleCast.framework and the app. The dynamic framework already includes them. This manifest links only that framework, preserving its bundled UI resources and avoiding the redundant static implementation.

Source: https://github.com/googlecast/google-cast-ios-sdk/blob/4.8.6/Package.swift
