// Independent Linux UAPI probe; creates two NEW files in an owned fixture directory.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *operation) {
    if (!ok) {
        fprintf(stderr, "%s: %s\n", operation, strerror(errno));
        exit(2);
    }
}

static int expected_refusal(int error) {
    return error == ENOTTY || error == EOPNOTSUPP || error == EINVAL ||
           error == EXDEV || error == ENOSYS || error == EPERM;
}

int main(int argc, char **argv) {
    require(argc == 2 || (argc == 3 && strcmp(argv[2], "--existing") == 0),
            "usage: linux-dedupe-probe OWNED_DIRECTORY [--existing]");
    int existing = argc == 3;
    int directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    require(directory >= 0 && fchdir(directory) == 0, "open fixture directory");
    int source = open("donor", (existing ? O_RDONLY : O_CREAT | O_EXCL | O_RDWR) | O_NOFOLLOW, 0600);
    int target = open("target", (existing ? O_RDWR : O_CREAT | O_EXCL | O_RDWR) | O_NOFOLLOW, 0600);
    require(source >= 0 && target >= 0, "create independent files");
    unsigned char bytes[65536 + 37], observed[sizeof(bytes)];
    for (size_t i = 0; i < sizeof(bytes); i++) bytes[i] = (i * 17 + 23) % 251;
    if (!existing) {
        require(write(source, bytes, sizeof(bytes)) == sizeof(bytes), "write source");
        require(write(target, bytes, sizeof(bytes)) == sizeof(bytes), "write target");
        require(fdatasync(source) == 0 && fdatasync(target) == 0, "sync fixture files");
        require(close(source) == 0, "close setup donor");
        source = open("donor", O_RDONLY | O_NOFOLLOW);
        require(source >= 0, "open donor read-only as production does");
    }
    struct stat a, b;
    require(fstat(source, &a) == 0 && fstat(target, &b) == 0 &&
            S_ISREG(a.st_mode) && S_ISREG(b.st_mode) && a.st_nlink == 1 && b.st_nlink == 1 &&
            (a.st_dev != b.st_dev || a.st_ino != b.st_ino) &&
            a.st_size == sizeof(bytes) && b.st_size == sizeof(bytes), "independent fixture file identities");
    require(pread(source, observed, sizeof(observed), 0) == sizeof(observed) &&
            memcmp(observed, bytes, sizeof(bytes)) == 0, "initial donor bytes");
    require(pread(target, observed, sizeof(observed), 0) == sizeof(observed) &&
            memcmp(observed, bytes, sizeof(bytes)) == 0, "initial target bytes");
    struct file_dedupe_range *range = calloc(1, sizeof(*range) + sizeof(range->info[0]));
    require(range != NULL, "allocate UAPI request");
    range->src_length = sizeof(bytes);
    range->dest_count = 1;
    range->info[0].dest_fd = target;
    errno = 0;
    int result = ioctl(source, FIDEDUPERANGE, range), saved_errno = errno;
    int status = range->info[0].status;
    unsigned long long shared = range->info[0].bytes_deduped;
    int supported = result == 0 && status == 0 && shared == sizeof(bytes);
    if (!supported) require((result < 0 && expected_refusal(saved_errno)) ||
                            (result == 0 && status < 0 && expected_refusal(-status)),
                            "unexpected equal-range failure");
    bytes[4096] ^= 0xff;
    require(pwrite(target, bytes + 4096, 1, 4096) == 1, "edit through open descriptor");
    require(fdatasync(target) == 0, "sync edited target");
    range->info[0].bytes_deduped = 0;
    range->info[0].status = 0;
    errno = 0;
    int changed_result = ioctl(source, FIDEDUPERANGE, range), changed_errno = errno;
    int changed_status = range->info[0].status;
    if (supported) require(changed_result == 0 && changed_status == FILE_DEDUPE_RANGE_DIFFERS &&
                           range->info[0].bytes_deduped == 0, "reject unequal bytes");
    require(pread(target, observed, sizeof(observed), 0) == sizeof(observed) &&
            memcmp(observed, bytes, sizeof(bytes)) == 0, "preserve edited target bytes");
    bytes[4096] ^= 0xff;
    require(pread(source, observed, sizeof(observed), 0) == sizeof(observed) &&
            memcmp(observed, bytes, sizeof(bytes)) == 0, "preserve donor bytes");
    printf("{\"request\":%lu,\"headerBytes\":%zu,\"infoBytes\":%zu,\"infoOffset\":%zu,"
           "\"supported\":%s,\"equalResult\":%d,\"equalErrno\":%d,\"equalStatus\":%d,"
           "\"dedupedBytes\":%llu,\"changedResult\":%d,\"changedErrno\":%d,\"changedStatus\":%d}\n",
           (unsigned long)FIDEDUPERANGE, sizeof(*range), sizeof(range->info[0]),
           offsetof(struct file_dedupe_range, info), supported ? "true" : "false",
           result, saved_errno, status, shared, changed_result, changed_errno, changed_status);
    free(range);
    require(close(source) == 0 && close(target) == 0 && close(directory) == 0, "close files");
    return 0;
}
