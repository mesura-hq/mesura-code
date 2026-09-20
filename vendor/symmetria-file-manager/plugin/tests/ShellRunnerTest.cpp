// ShellRunnerTest — unit tests for the QProcess-wrapping QML element.
//
// Uses QTEST_MAIN (with QGuiApplication via QT_QPA_PLATFORM=offscreen) so the
// QProcess child can spawn under any test environment. Commands are limited
// to /usr/bin/env, /bin/echo, /bin/cat, /bin/sh — present on every Arch /
// CI box.

#include "shellrunner.hpp"

#include <QSignalSpy>
#include <QTest>

using namespace symmetria::filemanager::models;

class ShellRunnerTest : public QObject {
    Q_OBJECT

private:
    // Wait for the spy to have at least one signal. If it already does, returns
    // immediately. Set up the spy BEFORE calling start() — QProcess fires
    // exited() asynchronously on the next event-loop tick, so a state-flag
    // check (running()) right after start() is racy and unreliable.
    static bool waitForSpy(QSignalSpy& spy, int timeout = 5000)
    {
        if (spy.count() > 0)
            return true;
        return spy.wait(timeout);
    }

private slots:
    void echoCapturesStdout()
    {
        ShellRunner runner;
        runner.setCommand({"/bin/echo", "hello world"});

        QSignalSpy startedSpy(&runner, &ShellRunner::started);
        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);

        runner.start();
        QVERIFY(waitForSpy(exitedSpy));
        QCOMPARE(exitedSpy.count(), 1);
        QCOMPARE(startedSpy.count(), 1);

        const QList<QVariant> args = exitedSpy.first();
        QCOMPARE(args.at(0).toInt(), 0);  // exit code 0
        QVERIFY(runner.stdoutText().contains("hello world"));
    }

    void exitCodePropagated()
    {
        ShellRunner runner;
        runner.setCommand({"/bin/sh", "-c", "exit 42"});

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(exitedSpy));

        QCOMPARE(runner.exitCode(), 42);
        QCOMPARE(runner.running(), false);
    }

    void stderrCaptured()
    {
        ShellRunner runner;
        runner.setCommand({"/bin/sh", "-c", "echo errstream 1>&2"});

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(exitedSpy));

        QVERIFY(runner.stderrText().contains("errstream"));
        QVERIFY(runner.stdoutText().isEmpty());
    }

    void writeAndCloseChannel()
    {
        // cat reads stdin, writes to stdout, exits when stdin closes.
        ShellRunner runner;
        runner.setCommand({"/bin/cat"});

        QSignalSpy startedSpy(&runner, &ShellRunner::started);
        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();

        // Wait for the process to actually start before writing.
        QVERIFY(waitForSpy(startedSpy));

        runner.write(QStringLiteral("payload\n"));
        runner.closeWriteChannel();

        QVERIFY(waitForSpy(exitedSpy));
        QVERIFY(runner.stdoutText().contains("payload"));
    }

    void writeBeforeStartedIsBufferedAndFlushed()
    {
        // The race fix: callers chain start() / write() / closeWriteChannel()
        // synchronously without waiting for started(). Pre-fix, write() and
        // closeWriteChannel() would no-op (with a warning) because m_running
        // was still false. Post-fix, the payload is buffered and flushed in
        // onStarted(), and the deferred close lets `cat` actually terminate.
        ShellRunner runner;
        runner.setCommand({"/bin/cat"});

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        // Intentionally NOT waiting for started() — this is the whole point.
        runner.write(QStringLiteral("buffered_payload\n"));
        runner.closeWriteChannel();

        QVERIFY(waitForSpy(exitedSpy));
        QVERIFY(runner.stdoutText().contains("buffered_payload"));
    }

    void closeWriteChannelBeforeStartedDeliversEof()
    {
        // Without the deferred close, `cat` would never receive EOF and
        // would hang until the test timeout. This test asserts the close
        // actually reaches the subprocess (i.e. `cat` exits on its own).
        ShellRunner runner;
        runner.setCommand({"/bin/cat"});

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        runner.closeWriteChannel();  // empty stdin, immediate EOF

        QVERIFY(waitForSpy(exitedSpy, 3000));
        QCOMPARE(runner.exitCode(), 0);
    }

    void failedToStartDoesNotRetainBufferedStdin()
    {
        // If the first run fails to start, any buffered stdin must be
        // discarded — otherwise a subsequent successful start() would
        // inherit leaked bytes from the dead run.
        ShellRunner runner;
        runner.setCommand({"/no/such/binary_xyz_should_not_exist"});

        QSignalSpy errorSpy(&runner, &ShellRunner::errorOccurred);
        runner.start();
        runner.write(QStringLiteral("leaked_bytes\n"));
        runner.closeWriteChannel();
        QVERIFY(waitForSpy(errorSpy));

        // Second run: command exists, but we want to confirm the leaked
        // stdin from run #1 doesn't surface in run #2's output.
        runner.setCommand({"/bin/cat"});
        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        runner.write(QStringLiteral("fresh_payload\n"));
        runner.closeWriteChannel();
        QVERIFY(waitForSpy(exitedSpy));

        QVERIFY(runner.stdoutText().contains("fresh_payload"));
        QVERIFY(!runner.stdoutText().contains("leaked_bytes"));
    }


    void multipleWritesBeforeStartedAreConcatenated()
    {
        // write() may be called multiple times before started() fires — each
        // call appends to m_pendingStdin. All buffered bytes must arrive at the
        // subprocess intact and in order (not just the last write or first write).
        ShellRunner runner;
        runner.setCommand({"/bin/cat"});

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        // Three writes before started() — intentionally not waiting.
        runner.write(QStringLiteral("alpha\n"));
        runner.write(QStringLiteral("beta\n"));
        runner.write(QStringLiteral("gamma\n"));
        runner.closeWriteChannel();

        QVERIFY(waitForSpy(exitedSpy));
        QVERIFY(runner.stdoutText().contains("alpha"));
        QVERIFY(runner.stdoutText().contains("beta"));
        QVERIFY(runner.stdoutText().contains("gamma"));
    }

    void doubleStartIsNoOp()
    {
        // Starting while already running should log a warning and not start
        // a second process. We can't easily observe the warning, but we can
        // assert the second start() doesn't break the first run.
        ShellRunner runner;
        runner.setCommand({"/bin/sh", "-c", "sleep 0.1"});

        QSignalSpy startedSpy(&runner, &ShellRunner::started);
        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(startedSpy));
        // Now actually running — second start should be a no-op.
        runner.start();
        QVERIFY(waitForSpy(exitedSpy));
        QCOMPARE(startedSpy.count(), 1);
        QCOMPARE(exitedSpy.count(), 1);
        QCOMPARE(runner.running(), false);
    }

    void emptyCommandEmitsErrorWithoutCrash()
    {
        ShellRunner runner;
        QSignalSpy errorSpy(&runner, &ShellRunner::errorOccurred);
        runner.start();  // no command set
        QCOMPARE(errorSpy.count(), 1);
        QCOMPARE(runner.running(), false);
    }

    void badExecutableEmitsError()
    {
        // QProcess fires errorOccurred with FailedToStart asynchronously when
        // exec() can't find the binary. Verifies the documented invariant in
        // ShellRunner::onErrorOccurred — m_running stays false (start() never
        // emitted started()), so no extra state correction is needed.
        ShellRunner runner;
        runner.setCommand({"/no/such/binary_xyz_should_not_exist"});

        QSignalSpy errorSpy(&runner, &ShellRunner::errorOccurred);
        QSignalSpy startedSpy(&runner, &ShellRunner::started);
        runner.start();

        QVERIFY(waitForSpy(errorSpy));
        QCOMPARE(errorSpy.count(), 1);
        QVERIFY(!errorSpy.first().at(0).toString().isEmpty());
        QCOMPARE(startedSpy.count(), 0);
        QCOMPARE(runner.running(), false);
    }

    void environmentMergesOverInherited()
    {
        // Inherited env has PATH, etc. The override adds SYMMETRIA_TEST_VAR.
        // We verify via /bin/sh -c "echo $SYMMETRIA_TEST_VAR".
        ShellRunner runner;
        runner.setCommand({"/bin/sh", "-c", "echo $SYMMETRIA_TEST_VAR"});
        QVariantMap env;
        env.insert("SYMMETRIA_TEST_VAR", "marker_xyz");
        runner.setEnvironment(env);

        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(exitedSpy));

        QVERIFY(runner.stdoutText().contains("marker_xyz"));
    }

    void rerunAfterExitClearsBuffers()
    {
        ShellRunner runner;
        runner.setCommand({"/bin/echo", "first"});

        QSignalSpy firstExitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(firstExitedSpy));
        QVERIFY(runner.stdoutText().contains("first"));

        runner.setCommand({"/bin/echo", "second"});
        QSignalSpy secondExitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(secondExitedSpy));

        // Buffer should reset between runs (start() clears it).
        QVERIFY(runner.stdoutText().contains("second"));
        QVERIFY(!runner.stdoutText().contains("first"));
    }

    void terminateWhileRunningStopsProcess()
    {
        ShellRunner runner;
        runner.setCommand({"/bin/sh", "-c", "sleep 5"});

        QSignalSpy startedSpy(&runner, &ShellRunner::started);
        QSignalSpy exitedSpy(&runner, &ShellRunner::exited);
        runner.start();
        QVERIFY(waitForSpy(startedSpy));
        QVERIFY(runner.running());

        runner.terminate();
        QVERIFY(waitForSpy(exitedSpy, 3000));
        QCOMPARE(runner.running(), false);
    }
};

QTEST_MAIN(ShellRunnerTest)
#include "ShellRunnerTest.moc"
