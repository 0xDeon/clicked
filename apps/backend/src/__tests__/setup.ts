process.env['JWT_SECRET'] = 'test-secret-for-ci-only';
process.env['DATABASE_URL'] = 'postgres://localhost/test';
process.env['OBJECT_STORE_ENDPOINT'] = 'http://localhost:9000';
process.env['OBJECT_STORE_BUCKET'] = 'clicked';
process.env['OBJECT_STORE_ACCESS_KEY'] = 'clicked';
process.env['OBJECT_STORE_SECRET_KEY'] = 'clickedsecret';
process.env['OBJECT_STORE_REGION'] = 'us-east-1';
process.env['OBJECT_STORE_FORCE_PATH_STYLE'] = 'true';
