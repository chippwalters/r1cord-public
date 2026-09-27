package com.chippwalters.r1cord.controls

import android.content.pm.PackageManager
import java.security.MessageDigest

/**
 * Decides whether a Binder caller may use R1CORD controls: the calling uid must map to exactly
 * the R1CORD package, and that package must have exactly one current signer whose DER
 * certificate SHA-256 equals the pinned CHIPPWALTERS release certificate.
 */
object CallerCheck {
    const val R1CORD_PACKAGE = "com.chippwalters.r1cord"
    const val R1CORD_CERT_SHA256 = "4e92be8e9853f7473f5fe9ed85fde56e2a8dac1280f279b2800861cd5265b7dc"

    /**
     * [packagesForUid] is `PackageManager.getPackagesForUid(callingUid)`. [signerDigests] returns the
     * lowercase SHA-256 of each current signer certificate of a package, or null when unreadable;
     * it is only consulted for the expected package. Any exception from it rejects the caller.
     */
    fun isAllowed(
        packagesForUid: Array<out String>?,
        signerDigests: (String) -> List<String>?,
        expectedPackage: String = R1CORD_PACKAGE,
        expectedCertSha256: String = R1CORD_CERT_SHA256,
    ): Boolean {
        // A shared uid lists several packages; any of them could be the real caller.
        if (packagesForUid == null || packagesForUid.size != 1 || packagesForUid[0] != expectedPackage) return false
        val digests = runCatching { signerDigests(expectedPackage) }.getOrNull() ?: return false
        return digests.size == 1 && MessageDigest.isEqual(
            digests[0].lowercase().toByteArray(), expectedCertSha256.lowercase().toByteArray())
    }

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /**
     * Digests of [packageName]'s current signer certificates (`apkContentsSigners`: the current
     * signer of a rotated v3 lineage, or every signer of a multi-signer package, which the caller
     * check then rejects).
     */
    fun signerDigests(packageManager: PackageManager, packageName: String): List<String>? {
        val info = packageManager.getPackageInfo(packageName,
            PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        val signing = info.signingInfo ?: return null
        return signing.apkContentsSigners?.map { sha256Hex(it.toByteArray()) }
    }
}
