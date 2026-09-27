# R1CORD controls release shrinking rules.

# Bound by the framework from the manifest; the AIDL stub is the Binder contract with R1CORD.
-keep class com.chippwalters.r1cord.controls.ControlService { *; }
-keep class com.chippwalters.r1cord.controls.IDeviceControls { *; }
-keep class com.chippwalters.r1cord.controls.IDeviceControls$* { *; }

# Keep line numbers in any crash report while hiding the original file name.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
