import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as integrations from 'aws-cdk-lib/aws-appintegrations';

export class CdkPatternApigLambdaAuroraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // RDS needs to be setup in a VPC
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Default is all AZs in the region
    });
    
    // We need this security group to add an ingress rule and allow our lambda to query the proxy
    let lambdaToRDSProxyGroup = new ec2.SecurityGroup(this, 'Lambda to RDS Proxy Connection', {
      vpc
    });
    // We need this security group to allow our proxy to query our MySQL Instance
    let dbConnectionGroup = new ec2.SecurityGroup(this, 'Proxy to DB Connection', {
      vpc
    });
    dbConnectionGroup.addIngressRule(dbConnectionGroup, ec2.Port.tcp(3306), 'allow db connection');
    dbConnectionGroup.addIngressRule(lambdaToRDSProxyGroup, ec2.Port.tcp(3306), 'allow lambda connection');

    const databaseUsername = 'syscdk';

    // Dynamically generate the username and password, then store in secrets manager
    const databaseCredentialsSecret = new secrets.Secret(this, 'DBCredentialsSecret', {
      secretName: id+'-rds-credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: databaseUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    new ssm.StringParameter(this, 'DBCredentialsArn', {
      parameterName: 'rds-credentials-arn',
      stringValue: databaseCredentialsSecret.secretArn,
    });

    // MySQL DB Instance (delete protection turned off because pattern is for learning.)
    // re-enable delete protection for a real implementation
    const rdsInstance = new rds.DatabaseInstance(this, 'DBInstance', {
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_5_7_30
      }),
      credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE2, ec2.InstanceSize.SMALL),
      vpc,
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
      securityGroups: [dbConnectionGroup]
    });

    // Create an RDS Proxy
    const proxy = rdsInstance.addProxy(id+'-proxy', {
        secrets: [databaseCredentialsSecret],
        debugLogging: true,
        vpc,
        securityGroups: [dbConnectionGroup]
    });
    
    // Workaround for bug where TargetGroupName is not set but required
    let targetGroup = proxy.node.children.find((child:any) => {
      return child instanceof rds.CfnDBProxyTargetGroup
    }) as rds.CfnDBProxyTargetGroup

    targetGroup.addPropertyOverride('TargetGroupName', 'default');
    
    // Lambda to Interact with RDS Proxy
    const rdsLambda = new lambda.NodejsFunction(this, 'RDSLambda', {
      vpc: vpc,
      securityGroups: [lambdaToRDSProxyGroup],
      environment: {
        PROXY_ENDPOINT: proxy.endpoint,
        RDS_SECRET_NAME: id+'-rds-credentials'
      }
    });

    databaseCredentialsSecret.grantRead(rdsLambda);

    // defines an API Gateway Http API resource backed by our "rdsLambda" function.
    let api = new apigw.LambdaRestApi(this, 'Endpoint', {
        handler: rdsLambda
    });

   new CfnOutput(this, 'HTTP API Url', {
     value: api.url ?? 'Something went wrong with the deploy'
   });
  }
}
