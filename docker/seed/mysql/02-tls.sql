-- A user that may log in only with a client certificate from the test CA (V4.3).
CREATE USER 'datanest_cert'@'%' IDENTIFIED BY 'datanest' REQUIRE X509;
GRANT SELECT ON datanest_test.* TO 'datanest_cert'@'%';
