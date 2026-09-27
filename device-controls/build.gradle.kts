plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.chippwalters.r1cord.controls"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.chippwalters.r1cord.controls"
        minSdk = 33
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }
    buildFeatures { aidl = true }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    buildTypes {
        // Deliberately unsigned: build.ps1 signs the release APK with the AOSP platform key,
        // which lives outside this repository. Debug uses the default debug key (compile checks only).
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}
dependencies {
    testImplementation("junit:junit:4.13.2")
}
