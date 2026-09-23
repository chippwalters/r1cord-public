# R1CORD release shrinking rules.
#
# Most of the app needs nothing: Compose, Room, Media3, CameraX and OkHttp all ship
# consumer rules. These cover the places where something outside Kotlin resolves a
# class by name, which R8 cannot see.

# Instantiated by the framework from the manifest.
-keep class com.chippwalters.r1cord.R1cordApplication { *; }
-keep class com.chippwalters.r1cord.MainActivity { *; }
-keep class com.chippwalters.r1cord.recording.RecordingService { *; }
-keep class com.chippwalters.r1cord.device.PowerMenuService { *; }

# Room generates an implementation looked up by name at runtime.
-keep class com.chippwalters.r1cord.storage.RecordingDatabase_Impl { *; }

# Tink (androidx.security-crypto) reads protobuf-backed key types reflectively.
-keep class com.google.crypto.tink.** { *; }
-dontwarn com.google.crypto.tink.**

# OkHttp/Okio reference optional platform APIs that are absent on Android.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Keep line numbers in any crash report while hiding the original file name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
