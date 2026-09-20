// EnvTest — unit tests for the environment-variable QML singleton.

#include "env.hpp"

#include <QTest>
#include <cstdlib>

using namespace symmetria::filemanager::models;

class EnvTest : public QObject {
    Q_OBJECT

private slots:
    void getReturnsValueWhenSet()
    {
        qputenv("SYMMETRIA_ENV_TEST_KEY", "the_value");
        Env env;
        QCOMPARE(env.get(QStringLiteral("SYMMETRIA_ENV_TEST_KEY")),
                 QStringLiteral("the_value"));
        qunsetenv("SYMMETRIA_ENV_TEST_KEY");
    }

    void getReturnsDefaultWhenUnset()
    {
        qunsetenv("SYMMETRIA_ENV_DOES_NOT_EXIST");
        Env env;
        QCOMPARE(env.get(QStringLiteral("SYMMETRIA_ENV_DOES_NOT_EXIST"),
                         QStringLiteral("fallback")),
                 QStringLiteral("fallback"));
    }

    void getReturnsEmptyStringByDefault()
    {
        qunsetenv("SYMMETRIA_ENV_DOES_NOT_EXIST");
        Env env;
        QCOMPARE(env.get(QStringLiteral("SYMMETRIA_ENV_DOES_NOT_EXIST")),
                 QString());
    }

    void hasReflectsPresence()
    {
        qputenv("SYMMETRIA_ENV_HAS_KEY", "x");
        Env env;
        QCOMPARE(env.has(QStringLiteral("SYMMETRIA_ENV_HAS_KEY")), true);
        qunsetenv("SYMMETRIA_ENV_HAS_KEY");
        QCOMPARE(env.has(QStringLiteral("SYMMETRIA_ENV_HAS_KEY")), false);
    }

    void homeIsTypicallyAvailable()
    {
        // Sanity check — the entire reason this class exists is to read HOME.
        // CI environments always set HOME; if this fails on your machine,
        // something is very wrong with your environment.
        Env env;
        const QString home = env.get(QStringLiteral("HOME"));
        QVERIFY2(!home.isEmpty(), "HOME is unset — environment is broken");
    }
};

QTEST_GUILESS_MAIN(EnvTest)
#include "EnvTest.moc"
